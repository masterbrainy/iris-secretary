import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRIEVAL,
  rankItems,
  selectAnswer,
  tokenize,
  type KnowledgeItem,
} from './retrieval.js';
import type { CallerIdentity } from './policy.js';

const CALLER: CallerIdentity = { contactId: 'contact-1', callerOrganizationId: 'acme' };
const STRANGER: CallerIdentity = { contactId: undefined, callerOrganizationId: undefined };

function item(
  overrides: Partial<KnowledgeItem> & Pick<KnowledgeItem, 'knowledgeItemId'>,
): KnowledgeItem {
  return {
    title: 'Untitled',
    answer: 'No answer.',
    status: 'approved',
    scope: { kind: 'general' },
    keywords: [],
    ...overrides,
  };
}

const HOURS = item({
  knowledgeItemId: 'k-hours',
  title: 'Opening hours',
  answer: 'We are open Monday to Friday, 9am to 5pm.',
  keywords: ['open', 'close', 'hours'],
});

const SHIPPING = item({
  knowledgeItemId: 'k-shipping',
  title: 'Shipping options',
  answer: 'Standard shipping takes three to five working days.',
  keywords: ['delivery', 'postage', 'dispatch'],
});

const PRICING_FOR_ACME = item({
  knowledgeItemId: 'k-acme-price',
  title: 'Acme negotiated rate',
  answer: 'Acme pays £42 per unit under their negotiated rate.',
  status: 'approved',
  scope: { kind: 'caller-organization', callerOrganizationId: 'acme' },
  keywords: ['price', 'rate', 'cost'],
});

const BASE = [HOURS, SHIPPING];

describe('tokenising', () => {
  it('drops punctuation, noise words, and interrogatives', () => {
    // "when" is dropped: the knowledge base is declarative, so question words
    // match arbitrary entries rather than the right one.
    expect(tokenize('When are you open?')).toEqual(['open']);
  });

  it('is case- and punctuation-insensitive', () => {
    expect(tokenize('SHIPPING!!!')).toEqual(tokenize('shipping'));
  });
});

describe('ranking', () => {
  it('puts the entry that covers the question first', () => {
    const ranked = rankItems('what are your opening hours', BASE);
    expect(ranked[0]?.item.knowledgeItemId).toBe('k-hours');
  });

  it('weights a rare term above one every entry shares', () => {
    const shared = [
      item({
        knowledgeItemId: 'k-1',
        title: 'Delivery to Scotland',
        answer: 'Delivery to Scotland takes longer.',
      }),
      item({
        knowledgeItemId: 'k-2',
        title: 'Delivery to Wales',
        answer: 'Delivery to Wales is standard.',
      }),
    ];

    const ranked = rankItems('delivery to scotland', shared);
    // "delivery" is in both, so "scotland" decides it.
    expect(ranked[0]?.item.knowledgeItemId).toBe('k-1');
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('matches on keywords the answer text does not contain', () => {
    const ranked = rankItems('how long is postage', BASE);
    expect(ranked[0]?.item.knowledgeItemId).toBe('k-shipping');
  });

  it('orders deterministically when scores tie', () => {
    const a = rankItems('nothing matches this at all', BASE).map((r) => r.item.knowledgeItemId);
    const b = rankItems('nothing matches this at all', BASE).map((r) => r.item.knowledgeItemId);
    expect(a).toEqual(b);
  });

  it('returns zero scores rather than throwing on an empty query', () => {
    expect(rankItems('   ', BASE).every((r) => r.score === 0)).toBe(true);
  });
});

describe('scope is applied before the answer is composed', () => {
  it('never lets another organisation see a negotiated rate', () => {
    const globex: CallerIdentity = { contactId: 'c-9', callerOrganizationId: 'globex' };
    const outcome = selectAnswer('what is our price per unit', [...BASE, PRICING_FOR_ACME], globex);

    // The critical assertion is about the TEXT, not just the source ids: a
    // scoped entry must not shape the words Iris says.
    expect(outcome.answer ?? '').not.toContain('42');
    expect(outcome.sourceIds).not.toContain('k-acme-price');
    expect(outcome.excluded.map((e) => e.item.knowledgeItemId)).toContain('k-acme-price');
  });

  it('does surface it to the organisation it belongs to', () => {
    const outcome = selectAnswer('what is our price per unit', [...BASE, PRICING_FOR_ACME], CALLER);
    expect(outcome.answer).toContain('£42');
    expect(outcome.sourceIds).toEqual(['k-acme-price']);
  });

  it('withholds scoped knowledge from an unidentified caller', () => {
    const outcome = selectAnswer('price per unit', [...BASE, PRICING_FOR_ACME], STRANGER);
    expect(outcome.answer).toBeUndefined();
    expect(outcome.reasons[0]).toContain('none of it is approved and in scope');
  });

  it('never draws on unapproved knowledge, whatever its status', () => {
    for (const status of ['proposed', 'rejected', 'archived'] as const) {
      const draft = item({
        knowledgeItemId: 'k-draft',
        title: 'Opening hours',
        answer: 'We are open until midnight.',
        status,
      });

      const outcome = selectAnswer('when are you open', [draft], CALLER);
      expect(outcome.answer, `${status} must not be used`).toBeUndefined();
    }
  });

  it('says matching knowledge existed but was withheld, rather than nothing matched', () => {
    const draft = item({
      knowledgeItemId: 'k-draft',
      title: 'Opening hours',
      answer: 'Open until midnight.',
      status: 'proposed',
    });

    const outcome = selectAnswer('when are you open', [draft], CALLER);
    expect(outcome.reasons[0]).toContain('none of it is approved and in scope');
  });
});

describe('confidence', () => {
  it('is high when one entry clearly covers the question', () => {
    const outcome = selectAnswer('what are your opening hours', BASE, CALLER);
    expect(outcome.answerConfidence).toBeGreaterThan(DEFAULT_RETRIEVAL.minScore);
    expect(outcome.sourceIds).toEqual(['k-hours']);
  });

  it('is zero when nothing clears the threshold', () => {
    const outcome = selectAnswer('do you sponsor visa applications', BASE, CALLER);
    expect(outcome.answerConfidence).toBe(0);
    expect(outcome.answer).toBeUndefined();
  });

  it('is cut when two entries match equally well, because that is ambiguity not confidence', () => {
    const twins = [
      item({ knowledgeItemId: 'k-a', title: 'Refund window', answer: 'Refunds within 30 days.' }),
      item({ knowledgeItemId: 'k-b', title: 'Refund window', answer: 'Refunds within 14 days.' }),
    ];

    const outcome = selectAnswer('refund window', twins, CALLER);
    const unambiguous = selectAnswer('refund window', [twins[0]!], CALLER);

    expect(outcome.answerConfidence).toBeLessThan(unambiguous.answerConfidence);
    expect(outcome.reasons.join(' ')).toContain('unclear which one');
  });

  it('reports exactly one source for the answer it gives', () => {
    const outcome = selectAnswer('what are your opening hours', BASE, CALLER);
    expect(outcome.sourceIds).toHaveLength(1);
    expect(outcome.answer).toBe(HOURS.answer);
  });
});

describe('explainability', () => {
  it('says which entry it used and how well it matched', () => {
    const outcome = selectAnswer('opening hours', BASE, CALLER);
    expect(outcome.reasons[0]).toContain('Opening hours');
    expect(outcome.reasons[0]).toMatch(/\d+% of the question/);
  });

  it('notes when entries were withheld alongside the answer it did give', () => {
    const globex: CallerIdentity = { contactId: 'c-9', callerOrganizationId: 'globex' };
    // A caller asking two things at once, one of which touches someone else's
    // negotiated rate. Both entries match well enough to be considered.
    const outcome = selectAnswer(
      'opening hours and our negotiated rate',
      [HOURS, PRICING_FOR_ACME],
      globex,
    );

    expect(outcome.answer).toBe(HOURS.answer);
    expect(outcome.reasons.join(' ')).toContain('withheld');
  });
});

describe('determinism', () => {
  it('returns the same outcome for the same inputs', () => {
    const once = selectAnswer('opening hours', BASE, CALLER);
    const twice = selectAnswer('opening hours', BASE, CALLER);
    expect(once).toEqual(twice);
  });
});
