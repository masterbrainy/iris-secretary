/**
 * Roadmap D.4 — the retrieval bake-off.
 *
 * CLAUDE.md scopes pgvector to "where semantic retrieval actually improves
 * knowledge search", which is a measurement, not an assumption. This file is
 * the measurement: a realistic seed knowledge base, two classes of question,
 * and an assertion on how the plain lexical ranker actually performs.
 *
 * It doubles as a regression guard — if a change to the ranker degrades either
 * class, this fails rather than quietly getting worse.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRIEVAL, rankItems, type KnowledgeItem } from './retrieval.js';

function entry(
  knowledgeItemId: string,
  title: string,
  answer: string,
  keywords: string[] = [],
): KnowledgeItem {
  return {
    knowledgeItemId,
    title,
    answer,
    status: 'approved',
    scope: { kind: 'general' },
    keywords,
  };
}

/** The seed set the PRD's "routine seeded questions" demo will run against. */
const SEED: KnowledgeItem[] = [
  entry(
    'k-hours',
    'Opening hours',
    'We are open Monday to Friday, 9am to 5pm, and closed at weekends.',
    ['open', 'closed', 'weekend'],
  ),
  entry('k-location', 'Where we are', 'Our workshop is at 14 Bridge Street, Manchester, M1 3JQ.', [
    'address',
    'located',
    'directions',
    'find',
  ]),
  entry(
    'k-lead-time',
    'Lead time on orders',
    'Standard orders ship in three weeks; larger runs take four to six.',
    ['production', 'turnaround', 'wait'],
  ),
  entry(
    'k-payment-terms',
    'Payment terms',
    'Invoices are net 30 for established accounts; new accounts pay 50% up front.',
    ['invoice', 'deposit', 'billing'],
  ),
  entry(
    'k-booking',
    'Booking a meeting',
    'You can book a call through the link on our website, or we can arrange one now.',
    ['appointment', 'schedule', 'call'],
  ),
  entry(
    'k-shipping',
    'Shipping options',
    'Standard shipping takes three to five working days; next-day is available.',
    ['delivery', 'postage', 'courier'],
  ),
  entry(
    'k-contact',
    'How to reach us',
    'The quickest route is hello@example.com, or this number during office hours.',
    ['email', 'phone', 'reach'],
  ),
  entry(
    'k-warranty',
    'Warranty',
    'Everything we make carries a two-year warranty against manufacturing defects.',
    ['guarantee', 'covered', 'defect'],
  ),
];

interface Question {
  readonly asked: string;
  readonly expects: string;
}

/** Phrasings that share vocabulary with the entry. */
const DIRECT: Question[] = [
  { asked: 'what are your opening hours', expects: 'k-hours' },
  { asked: 'where are you located', expects: 'k-location' },
  { asked: 'what is the lead time on an order', expects: 'k-lead-time' },
  { asked: 'what are your payment terms', expects: 'k-payment-terms' },
  { asked: 'can I book a meeting', expects: 'k-booking' },
  { asked: 'what shipping options do you have', expects: 'k-shipping' },
  { asked: 'what is your email address', expects: 'k-contact' },
  { asked: 'how long is the warranty', expects: 'k-warranty' },
];

/**
 * The same questions asked the way people actually ask them — little or no
 * shared vocabulary with the entry. This is precisely the class semantic
 * retrieval is supposed to rescue.
 */
const PARAPHRASED: Question[] = [
  { asked: 'are you around on a Saturday', expects: 'k-hours' },
  { asked: 'how do I get to your workshop', expects: 'k-location' },
  { asked: 'how quickly can you turn something around', expects: 'k-lead-time' },
  { asked: 'do I have to pay everything up front', expects: 'k-payment-terms' },
  { asked: 'could we set up a time to talk', expects: 'k-booking' },
  { asked: 'how soon would it arrive', expects: 'k-shipping' },
  { asked: 'what is the best way to get hold of someone', expects: 'k-contact' },
  { asked: 'what happens if it breaks', expects: 'k-warranty' },
];

/**
 * The top hit *as production would see it* — i.e. subject to the same score
 * threshold `selectAnswer` applies. Measuring without the threshold would
 * count weak accidental matches as successes and flatter the ranker.
 */
function topHit(asked: string): string | undefined {
  const best = rankItems(asked, SEED)[0];
  return best !== undefined && best.score >= DEFAULT_RETRIEVAL.minScore
    ? best.item.knowledgeItemId
    : undefined;
}

function measure(questions: readonly Question[]) {
  const misses = questions.filter((q) => topHit(q.asked) !== q.expects);
  return {
    total: questions.length,
    hits: questions.length - misses.length,
    misses,
  };
}

describe('plain lexical retrieval on the seed set', () => {
  it('answers every directly-phrased question correctly', () => {
    const result = measure(DIRECT);

    // A failure here means the MVP demo set itself is at risk, which would be
    // a blocker rather than a nice-to-have.
    expect(
      result.misses.map(
        (m) => `${m.asked} -> expected ${m.expects}, got ${String(topHit(m.asked))}`,
      ),
    ).toEqual([]);
    expect(result.hits).toBe(result.total);
  });

  it('measurably struggles with paraphrases, which is the case for semantic search', () => {
    const result = measure(PARAPHRASED);

    // Recorded rather than aspirational: this is what the lexical ranker
    // actually manages today, and it is the evidence behind the pgvector
    // decision in DECISIONS-LOG.md. If a ranker change moves it, this fails
    // and the decision gets revisited rather than silently going stale.
    expect(result.hits).toBeLessThan(result.total);
    // Measured, not aspirational: 2/8 as of 2026-07-31. This is the evidence
    // behind the pgvector decision in DECISIONS-LOG.md. If a ranker change
    // moves it, this fails and the decision gets revisited rather than
    // silently going stale.
    expect(result.hits).toBe(2);
  });

  it('fails safely on paraphrases — no confident wrong answers', () => {
    // This is the finding that decides how urgent semantic search is. Missing
    // a paraphrase routes to escalation, which is merely inefficient. Matching
    // the WRONG entry would put a wrong answer in a client's ear, which is not.
    for (const miss of measure(PARAPHRASED).misses) {
      expect(topHit(miss.asked), `"${miss.asked}" must not match the wrong entry`).toBeUndefined();
    }
  });

  it('never invents a match for a question the knowledge base does not cover', () => {
    // The dangerous failure is a confident wrong answer, not a miss.
    for (const asked of [
      'do you sponsor visa applications',
      'who is your insurance underwriter',
      'what is the airspeed velocity of a swallow',
    ]) {
      const ranked = rankItems(asked, SEED);
      expect(ranked[0]?.score ?? 0, `"${asked}" should not match strongly`).toBeLessThan(0.34);
    }
  });
});
