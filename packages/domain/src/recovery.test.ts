import { describe, expect, it } from 'vitest';
import {
  deriveConversationFollowUpKey,
  planRecovery,
  type DependencyKind,
  type FailureContext,
} from './recovery.js';

function failure(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    dependency: 'telephony',
    conversationId: 'conv-1',
    escalationId: undefined,
    clientStillConnected: true,
    callbackKnown: false,
    existingFollowUpKeys: [],
    detail: 'connection reset',
    ...overrides,
  };
}

const ALL_DEPENDENCIES: DependencyKind[] = [
  'telephony',
  'ai-service',
  'realtime',
  'wearable',
  'database',
];

describe('the client is never left in unexplained silence', () => {
  it('always speaks to a client who is still on the line', () => {
    for (const dependency of ALL_DEPENDENCIES) {
      const plan = planRecovery(failure({ dependency, clientStillConnected: true }));
      expect(plan.speakToClient, `${dependency} must not leave the client silent`).toBe(true);
    }
  });

  it('lands in DEFERRED while the client is connected, so they are owed a follow-up', () => {
    expect(planRecovery(failure({ clientStillConnected: true })).safeState).toBe('DEFERRED');
  });

  it('ends the conversation once the client has already gone', () => {
    const plan = planRecovery(failure({ clientStillConnected: false }));
    expect(plan.safeState).toBe('ENDED');
    expect(plan.speakToClient).toBe(false);
  });
});

describe('callback capture', () => {
  it('asks for a number when the client is present and we have none', () => {
    const plan = planRecovery(failure({ clientStillConnected: true, callbackKnown: false }));
    expect(plan.captureCallback).toBe(true);
    expect(plan.reasons.join(' ')).toContain('No callback number');
  });

  it('does not ask when we already have one', () => {
    expect(planRecovery(failure({ callbackKnown: true })).captureCallback).toBe(false);
  });

  it('cannot ask once the client has hung up', () => {
    const plan = planRecovery(failure({ clientStillConnected: false, callbackKnown: false }));
    expect(plan.captureCallback).toBe(false);
  });
});

describe('exactly one follow-up', () => {
  it('creates one on the first failure', () => {
    const plan = planRecovery(failure());
    expect(plan.createFollowUp).toBe(true);
    expect(plan.followUpKey).toBe(deriveConversationFollowUpKey('conv-1'));
  });

  it('does not create a second when the dependency fails again on the same call', () => {
    const first = planRecovery(failure());
    const again = planRecovery(failure({ existingFollowUpKeys: [first.followUpKey] }));

    expect(again.createFollowUp).toBe(false);
    expect(again.reasons.join(' ')).toContain('already exists');
  });

  it('keys on the escalation when the failure happened during one', () => {
    const plan = planRecovery(failure({ escalationId: 'esc-9' }));
    expect(plan.followUpKey).toBe('follow-up:esc-9');
  });

  it('keeps follow-ups from different conversations distinct', () => {
    expect(deriveConversationFollowUpKey('conv-1')).not.toBe(
      deriveConversationFollowUpKey('conv-2'),
    );
  });

  it('still owes a follow-up even after the client hung up', () => {
    // The thread is not dead just because the call dropped — somebody has to
    // ring them back, and that is precisely what gets forgotten.
    expect(planRecovery(failure({ clientStillConnected: false })).createFollowUp).toBe(true);
  });
});

describe('operator alerting', () => {
  it('alerts on every dependency, naming which one failed', () => {
    const expectations: [DependencyKind, string][] = [
      ['telephony', 'phone provider'],
      ['ai-service', 'AI service'],
      ['realtime', 'realtime channel'],
      ['wearable', 'glasses integration'],
      ['database', 'database'],
    ];

    for (const [dependency, phrase] of expectations) {
      const plan = planRecovery(failure({ dependency }));
      expect(plan.alert.summary).toContain(phrase);
    }
  });

  it('treats a failure with someone waiting as critical', () => {
    expect(planRecovery(failure({ clientStillConnected: true })).alert.severity).toBe('critical');
  });

  it('treats a failure after disconnect as a warning', () => {
    expect(planRecovery(failure({ clientStillConnected: false })).alert.severity).toBe('warning');
  });
});

describe('all four obligations are met at once', () => {
  it('satisfies safe state, callback, follow-up and alert from a single decision', () => {
    // The realistic failure: telephony dies mid-call, nobody has the number.
    const plan = planRecovery(
      failure({
        dependency: 'telephony',
        clientStillConnected: true,
        callbackKnown: false,
        detail: 'websocket closed',
      }),
    );

    expect(plan.safeState).toBe('DEFERRED');
    expect(plan.captureCallback).toBe(true);
    expect(plan.createFollowUp).toBe(true);
    expect(plan.alert.severity).toBe('critical');
    expect(plan.speakToClient).toBe(true);
  });

  it('explains itself, including the underlying detail', () => {
    const plan = planRecovery(failure({ detail: 'websocket closed' }));
    expect(plan.reasons[0]).toContain('websocket closed');
    expect(plan.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe('purity', () => {
  it('returns the same plan for the same failure every time', () => {
    expect(planRecovery(failure())).toEqual(planRecovery(failure()));
  });
});
