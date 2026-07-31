import { describe, expect, it } from 'vitest';
import {
  MAX_CONTEXT_WORDS,
  assessPriority,
  buildEscalationPacket,
  clampContext,
  type CallerSummary,
  type PacketInput,
  type PrioritySignals,
  type RelationshipStatus,
} from './escalation-packet.js';

const CALLER: CallerSummary = {
  contactId: 'contact-1',
  displayName: 'Dana Reyes',
  organizationName: 'Acme',
  phoneNumber: '+15550001',
};

function signals(overrides: Partial<PrioritySignals> = {}): PrioritySignals {
  return {
    isVip: false,
    relationship: 'known',
    hasActiveDeal: false,
    recognizedOrganization: undefined,
    urgency: 'routine',
    isKnownCaller: true,
    ...overrides,
  };
}

function packetInput(overrides: Partial<PacketInput> = {}): PacketInput {
  return {
    escalationId: 'esc-1',
    conversationId: 'conv-1',
    traceId: 'trace-1',
    caller: CALLER,
    signals: signals(),
    intent: 'asking about lead time on a bulk order',
    question: 'What is your lead time on 500 units?',
    context: 'Caller has ordered twice before. Asking about a larger order than usual.',
    handoffAvailable: true,
    issuedAt: '2026-07-31T10:00:00.000Z',
    ttlMs: 45_000,
    ...overrides,
  };
}

function build(overrides: Partial<PacketInput> = {}) {
  const result = buildEscalationPacket(packetInput(overrides));
  if (!result.ok) throw new Error(`expected a valid packet: ${result.message}`);
  return result.packet;
}

describe('an unknown caller is never low priority merely for being unknown', () => {
  it('floors an unidentified caller with no other signals at normal', () => {
    const assessment = assessPriority(
      signals({ isKnownCaller: false, relationship: 'unknown', urgency: 'routine' }),
    );

    expect(assessment.priority).toBe('normal');
    expect(assessment.reasons.join(' ')).toContain('could not be identified');
  });

  it('says explicitly that the floor was applied, so the founder can see why', () => {
    const assessment = assessPriority(signals({ isKnownCaller: false, relationship: 'unknown' }));
    expect(assessment.reasons.some((r) => r.includes('rather than low'))).toBe(true);
  });

  it('still allows low priority for an identified caller with no signals', () => {
    const assessment = assessPriority(
      signals({ isKnownCaller: true, relationship: 'new', urgency: 'routine' }),
    );

    expect(assessment.priority).toBe('low');
  });

  it('does not drag a well-signalled unknown caller down', () => {
    const assessment = assessPriority(
      signals({ isKnownCaller: false, relationship: 'unknown', urgency: 'urgent' }),
    );

    expect(assessment.priority).toBe('high');
  });
});

describe('priority is explainable from configured signals', () => {
  it('gives a reason for every signal that fired', () => {
    const assessment = assessPriority(
      signals({
        isVip: true,
        hasActiveDeal: true,
        recognizedOrganization: 'Acme',
        relationship: 'active-client',
        urgency: 'urgent',
      }),
    );

    const joined = assessment.reasons.join(' ');
    expect(joined).toContain('VIP');
    expect(joined).toContain('active deal');
    expect(joined).toContain('Acme');
    expect(joined).toContain('active client');
    expect(joined).toContain('urgent');
    expect(assessment.priority).toBe('critical');
  });

  it('never returns an empty explanation', () => {
    const relationships: RelationshipStatus[] = [
      'unknown',
      'new',
      'known',
      'active-client',
      'former-client',
    ];

    for (const relationship of relationships) {
      const assessment = assessPriority(signals({ relationship }));
      expect(assessment.reasons.length, `${relationship} needs a reason`).toBeGreaterThan(0);
    }
  });

  it('escalates priority as signals accumulate', () => {
    const base = assessPriority(signals({ relationship: 'new' }));
    const withDeal = assessPriority(signals({ relationship: 'new', hasActiveDeal: true }));
    const withVip = assessPriority(
      signals({ relationship: 'new', hasActiveDeal: true, isVip: true }),
    );
    const alsoUrgent = assessPriority(
      signals({ relationship: 'new', hasActiveDeal: true, isVip: true, urgency: 'urgent' }),
    );

    expect(base.priority).toBe('low');
    expect(withDeal.priority).toBe('normal');
    // A VIP with a live deal is high, not critical — critical is reserved for
    // that plus urgency or a deeper relationship, so it keeps meaning something.
    expect(withVip.priority).toBe('high');
    expect(alsoUrgent.priority).toBe('critical');
  });
});

describe('packet contents', () => {
  it('carries everything the PRD requires', () => {
    const packet = build();

    expect(packet.escalationId).toBe('esc-1');
    expect(packet.conversationId).toBe('conv-1');
    expect(packet.caller.displayName).toBe('Dana Reyes');
    expect(packet.caller.organizationName).toBe('Acme');
    expect(packet.relationship).toBe('known');
    expect(packet.priority).toBeDefined();
    expect(packet.priorityReasons.length).toBeGreaterThan(0);
    expect(packet.intent).toContain('lead time');
    expect(packet.question).toBe('What is your lead time on 500 units?');
    expect(packet.context.length).toBeGreaterThan(0);
    expect(packet.allowedActions.length).toBeGreaterThan(0);
    expect(packet.expiresAt).toBe('2026-07-31T10:00:45.000Z');
  });

  it('keeps the question verbatim, never reworded or trimmed', () => {
    const asked =
      "So, uh, what's the lead time on 500 units — and can you do better than last time?";
    const packet = build({ question: asked });
    expect(packet.question).toBe(asked);
  });

  it('carries a recommended answer only when one was supplied', () => {
    expect(build().recommendedAnswer).toBeUndefined();
    expect(build({ recommendedAnswer: 'Usually three weeks.' }).recommendedAnswer).toBe(
      'Usually three weeks.',
    );
  });
});

describe('context is capped at 40 words', () => {
  it('leaves short context alone', () => {
    const result = clampContext('Caller has ordered twice before.');
    expect(result.truncated).toBe(false);
    expect(result.context).toBe('Caller has ordered twice before.');
  });

  it('truncates longer context and marks it visibly', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${String(i)}`).join(' ');
    const result = clampContext(long);

    expect(result.truncated).toBe(true);
    expect(result.context.split(/\s+/)).toHaveLength(MAX_CONTEXT_WORDS);
    expect(result.context.endsWith('…')).toBe(true);
  });

  it('accepts exactly 40 words without truncating', () => {
    const exact = Array.from({ length: MAX_CONTEXT_WORDS }, (_, i) => `w${String(i)}`).join(' ');
    expect(clampContext(exact).truncated).toBe(false);
  });

  it('flags truncation on the packet so the founder knows it is an excerpt', () => {
    const long = Array.from({ length: 100 }, (_, i) => `word${String(i)}`).join(' ');
    const packet = build({ context: long });

    expect(packet.contextTruncated).toBe(true);
    expect(packet.context.split(/\s+/).length).toBeLessThanOrEqual(MAX_CONTEXT_WORDS + 1);
  });
});

describe('allowed actions', () => {
  it('offers take-call only when a transfer is actually possible', () => {
    expect(build({ handoffAvailable: true }).allowedActions).toContain('take-call');
    expect(build({ handoffAvailable: false }).allowedActions).not.toContain('take-call');
  });

  it('always offers answer, decline and defer', () => {
    for (const handoffAvailable of [true, false]) {
      const actions = build({ handoffAvailable }).allowedActions;
      expect(actions).toContain('answer');
      expect(actions).toContain('decline');
      expect(actions).toContain('defer');
    }
  });

  it('offers take-call as a choice even at critical priority, never as an automatic action', () => {
    const packet = build({
      signals: signals({ isVip: true, hasActiveDeal: true, urgency: 'urgent' }),
      handoffAvailable: true,
    });

    // Priority may be maximal, but handoff is still only ever an option the
    // founder can decline — CLAUDE.md requires explicit acceptance regardless.
    expect(packet.priority).toBe('critical');
    expect(packet.allowedActions).toContain('take-call');
    expect(packet.allowedActions).toContain('decline');
  });
});

describe('expiry', () => {
  it('computes expiry from the injected issue time', () => {
    const packet = build({ issuedAt: '2026-07-31T12:00:00.000Z', ttlMs: 30_000 });
    expect(packet.expiresAt).toBe('2026-07-31T12:00:30.000Z');
  });

  it('refuses a packet that would never expire', () => {
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = buildEscalationPacket(packetInput({ ttlMs }));
      expect(result.ok, `ttl ${String(ttlMs)} must be refused`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-ttl');
    }
  });

  it('refuses an unparseable issue time rather than inventing one', () => {
    const result = buildEscalationPacket(packetInput({ issuedAt: 'not-a-date' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-issued-at');
  });
});

describe('validation', () => {
  it('refuses a packet with no id, no conversation, or no question', () => {
    expect(buildEscalationPacket(packetInput({ escalationId: '' })).ok).toBe(false);
    expect(buildEscalationPacket(packetInput({ conversationId: '' })).ok).toBe(false);
    expect(buildEscalationPacket(packetInput({ question: '   ' })).ok).toBe(false);
  });
});

describe('purity', () => {
  it('builds the same packet from the same input every time', () => {
    expect(buildEscalationPacket(packetInput())).toEqual(buildEscalationPacket(packetInput()));
  });
});
