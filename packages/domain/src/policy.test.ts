import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  SENSITIVE_CATEGORIES,
  canAskClarification,
  decideHandoff,
  decideResolution,
  deriveFollowUpKey,
  isUsableForCaller,
  planDeferral,
  type CallerIdentity,
  type FounderReply,
  type KnowledgeCandidate,
  type ResolutionRequest,
} from './policy.js';

const CALLER: CallerIdentity = { contactId: 'contact-1', callerOrganizationId: 'acme' };

const APPROVED_GENERAL: KnowledgeCandidate = {
  knowledgeItemId: 'k-1',
  status: 'approved',
  scope: { kind: 'general' },
};

function request(overrides: Partial<ResolutionRequest> = {}): ResolutionRequest {
  return {
    caller: CALLER,
    candidates: [APPROVED_GENERAL],
    answerConfidence: 0.95,
    detectedCategories: [],
    transcriptionConfidence: 0.95,
    involvesCriticalDetail: false,
    clarificationCount: 0,
    policy: DEFAULT_POLICY,
    ...overrides,
  };
}

describe('sensitive categories always escalate', () => {
  it('escalates every category CLAUDE.md places out of scope', () => {
    for (const category of SENSITIVE_CATEGORIES) {
      const decision = decideResolution(request({ detectedCategories: [category] }));
      expect(decision.action, `${category} must escalate`).toBe('escalate');
    }
  });

  it('escalates a refund even when perfectly sourced and maximally confident', () => {
    const decision = decideResolution(
      request({
        detectedCategories: ['refund'],
        answerConfidence: 1,
        transcriptionConfidence: 1,
        candidates: [APPROVED_GENERAL],
      }),
    );

    // Being certain about a refund is not authorisation to issue one.
    expect(decision.action).toBe('escalate');
    expect(decision.reasons[0]).toContain('refund');
  });

  it('never returns source ids alongside an escalation', () => {
    const decision = decideResolution(request({ detectedCategories: ['commitment'] }));
    expect(decision).not.toHaveProperty('sourceIds');
  });
});

describe('knowledge scope — customer information stays with that customer', () => {
  it('will not use another contact’s knowledge', () => {
    const otherContacts: KnowledgeCandidate = {
      knowledgeItemId: 'k-private',
      status: 'approved',
      scope: { kind: 'contact', contactId: 'contact-999' },
    };

    expect(isUsableForCaller(otherContacts, CALLER)).toBe(false);

    const decision = decideResolution(request({ candidates: [otherContacts] }));
    expect(decision.action).toBe('escalate');
  });

  it('uses knowledge scoped to this very contact', () => {
    const theirs: KnowledgeCandidate = {
      knowledgeItemId: 'k-theirs',
      status: 'approved',
      scope: { kind: 'contact', contactId: 'contact-1' },
    };

    const decision = decideResolution(request({ candidates: [theirs] }));
    expect(decision.action).toBe('answer');
    if (decision.action === 'answer') expect(decision.sourceIds).toEqual(['k-theirs']);
  });

  it('will not use another organisation’s knowledge', () => {
    const rival: KnowledgeCandidate = {
      knowledgeItemId: 'k-rival',
      status: 'approved',
      scope: { kind: 'caller-organization', callerOrganizationId: 'globex' },
    };

    expect(isUsableForCaller(rival, CALLER)).toBe(false);
  });

  it('will not use scoped knowledge for an unidentified caller', () => {
    const unknown: CallerIdentity = { contactId: undefined, callerOrganizationId: undefined };
    const scoped: KnowledgeCandidate = {
      knowledgeItemId: 'k-scoped',
      status: 'approved',
      scope: { kind: 'contact', contactId: 'contact-1' },
    };

    expect(isUsableForCaller(scoped, unknown)).toBe(false);
  });

  it('refuses unapproved knowledge at every status', () => {
    for (const status of ['proposed', 'rejected', 'archived'] as const) {
      const candidate: KnowledgeCandidate = {
        knowledgeItemId: 'k-x',
        status,
        scope: { kind: 'general' },
      };
      expect(isUsableForCaller(candidate, CALLER), `${status} must not be usable`).toBe(false);
    }
  });

  it('excludes unusable candidates from the source ids it reports', () => {
    const decision = decideResolution(
      request({
        candidates: [
          APPROVED_GENERAL,
          { knowledgeItemId: 'k-proposed', status: 'proposed', scope: { kind: 'general' } },
          {
            knowledgeItemId: 'k-other',
            status: 'approved',
            scope: { kind: 'contact', contactId: 'contact-999' },
          },
        ],
      }),
    );

    expect(decision.action).toBe('answer');
    if (decision.action === 'answer') expect(decision.sourceIds).toEqual(['k-1']);
  });
});

describe('confidence thresholds', () => {
  it('escalates when answer confidence is below the threshold', () => {
    const decision = decideResolution(request({ answerConfidence: 0.5 }));
    expect(decision.action).toBe('escalate');
    expect(decision.reasons[0]).toContain('threshold');
  });

  it('answers at exactly the threshold', () => {
    const decision = decideResolution(
      request({ answerConfidence: DEFAULT_POLICY.minAnswerConfidence }),
    );
    expect(decision.action).toBe('answer');
  });

  it('confirms a critical detail heard with low confidence rather than guessing', () => {
    const decision = decideResolution(
      request({ involvesCriticalDetail: true, transcriptionConfidence: 0.4 }),
    );

    expect(decision.action).toBe('confirm');
  });

  it('does not confirm when the poorly-heard part is not critical', () => {
    const decision = decideResolution(
      request({ involvesCriticalDetail: false, transcriptionConfidence: 0.4 }),
    );

    expect(decision.action).toBe('answer');
  });

  it('escalates instead of confirming once the one clarification is spent', () => {
    const decision = decideResolution(
      request({
        involvesCriticalDetail: true,
        transcriptionConfidence: 0.4,
        clarificationCount: 1,
      }),
    );

    expect(decision.action).toBe('escalate');
    expect(decision.reasons[0]).toContain('already been used');
  });
});

describe('gate ordering', () => {
  it('checks sensitivity before confidence, sourcing, and transcription', () => {
    const decision = decideResolution(
      request({
        detectedCategories: ['purchase'],
        answerConfidence: 0,
        candidates: [],
        involvesCriticalDetail: true,
        transcriptionConfidence: 0,
      }),
    );

    expect(decision.action).toBe('escalate');
    // The sensitivity reason wins, not the missing-knowledge one.
    expect(decision.reasons[0]).toContain('purchase');
  });
});

describe('one clarification question', () => {
  it('allows the first and refuses the second', () => {
    expect(canAskClarification(0).allowed).toBe(true);

    const second = canAskClarification(1);
    expect(second.allowed).toBe(false);
    if (!second.allowed) expect(second.reason).toContain('resolve, escalate, or defer');
  });
});

describe('handoff requires explicit acceptance', () => {
  it('accepts only the explicit take-call signal', () => {
    expect(decideHandoff({ kind: 'take-call' }).accepted).toBe(true);
  });

  it('refuses to infer acceptance from the wording of an answer', () => {
    const sounds_like_yes: FounderReply = {
      kind: 'answer',
      text: 'Sure, put them through to me.',
    };

    const decision = decideHandoff(sounds_like_yes);
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain('never inferred');
  });

  it('never treats silence as acceptance', () => {
    expect(decideHandoff({ kind: 'timeout' }).accepted).toBe(false);
    expect(decideHandoff({ kind: 'timeout' }).reason).toContain('Silence is never acceptance');
  });

  it('refuses every non-explicit reply', () => {
    const replies: FounderReply[] = [
      { kind: 'answer', text: 'anything at all' },
      { kind: 'decline' },
      { kind: 'defer' },
      { kind: 'timeout' },
      { kind: 'undeliverable' },
    ];

    for (const reply of replies) {
      expect(decideHandoff(reply).accepted, `${reply.kind} must not accept`).toBe(false);
    }
  });
});

describe('deferral creates exactly one follow-up and never an answer', () => {
  it('creates a follow-up the first time', () => {
    const plan = planDeferral({
      escalationId: 'esc-1',
      cause: 'founder-timeout',
      existingFollowUpKeys: [],
    });

    expect(plan.createFollowUp).toBe(true);
    expect(plan.followUpKey).toBe(deriveFollowUpKey('esc-1'));
    expect(plan.answerToClient).toBeNull();
  });

  it('does not create a second follow-up for the same escalation', () => {
    const first = planDeferral({
      escalationId: 'esc-1',
      cause: 'founder-timeout',
      existingFollowUpKeys: [],
    });

    const retry = planDeferral({
      escalationId: 'esc-1',
      cause: 'founder-timeout',
      existingFollowUpKeys: [first.followUpKey],
    });

    expect(retry.createFollowUp).toBe(false);
    expect(retry.reasons.join(' ')).toContain('already exists');
  });

  it('keeps follow-ups from different escalations distinct', () => {
    expect(deriveFollowUpKey('esc-1')).not.toBe(deriveFollowUpKey('esc-2'));
  });

  it('never carries an answer, whatever the cause', () => {
    const causes = [
      'founder-timeout',
      'founder-declined',
      'founder-deferred',
      'prompt-undeliverable',
      'dependency-failure',
      'policy-rejected-answer',
    ] as const;

    for (const cause of causes) {
      const plan = planDeferral({ escalationId: 'esc-1', cause, existingFollowUpKeys: [] });
      expect(plan.answerToClient, `${cause} must not fabricate an answer`).toBeNull();
      expect(plan.reasons[0]).toContain('Deferring because');
    }
  });
});

describe('explainability', () => {
  it('gives a readable reason with every decision', () => {
    const decisions = [
      decideResolution(request()),
      decideResolution(request({ detectedCategories: ['refund'] })),
      decideResolution(request({ answerConfidence: 0.1 })),
      decideResolution(request({ candidates: [] })),
      decideResolution(request({ involvesCriticalDetail: true, transcriptionConfidence: 0.2 })),
    ];

    for (const decision of decisions) {
      expect(decision.reasons.length).toBeGreaterThan(0);
      expect(decision.reasons[0]!.length).toBeGreaterThan(10);
    }
  });
});

describe('purity', () => {
  it('returns the same decision for the same request every time', () => {
    const req = request({ answerConfidence: 0.8 });
    expect(decideResolution(req)).toEqual(decideResolution(req));
  });

  it('does not mutate the candidate list it was given', () => {
    const candidates: KnowledgeCandidate[] = [APPROVED_GENERAL];
    decideResolution(request({ candidates }));
    expect(candidates).toEqual([APPROVED_GENERAL]);
  });
});
