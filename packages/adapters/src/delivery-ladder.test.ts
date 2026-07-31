import { describe, expect, it } from 'vitest';
import { planRecovery } from '@iris/domain';
import { cancelAcrossLadder, deliverViaLadder, rungIdempotencyKey } from './delivery-ladder.js';
import { createMetaWearableSimulator } from './meta-wearable/simulator.js';
import { createA1MobileSimulator } from './a1mobile/simulator.js';
import { createMetaWearableProductionAdapter } from './meta-wearable/production.js';
import type {
  DeliveryOptions,
  FounderResponseEvent,
  WearablePrompt,
} from './meta-wearable/contract.js';

const PROMPT: WearablePrompt = {
  escalationId: 'esc-1',
  conversationId: 'conv-1',
  traceId: 'trace-1',
  spokenText: 'Dana from Acme is asking your lead time on 500 units.',
  displayText: 'Dana (Acme): lead time on 500 units?',
  allowedActions: ['answer', 'decline', 'defer', 'take-call'],
  expiresAt: '2026-07-31T10:00:45.000Z',
};

const OPTS: DeliveryOptions = { idempotencyKey: 'deliver:esc-1', timeoutMs: 45_000 };

function ladder() {
  return {
    glasses: createMetaWearableSimulator({ channel: 'glasses' }),
    companion: createMetaWearableSimulator({ channel: 'companion-app' }),
    inbox: createMetaWearableSimulator({ channel: 'web-inbox' }),
  };
}

describe('the ladder descends until a rung acknowledges', () => {
  it('stops at the first rung when the glasses take it', async () => {
    const { glasses, companion, inbox } = ladder();
    const result = await deliverViaLadder([glasses, companion, inbox], PROMPT, OPTS);

    expect(result.delivered).toBe(true);
    if (result.delivered) expect(result.channel).toBe('glasses');
    expect(result.attempts).toHaveLength(1);
    // The lower rungs were never disturbed.
    expect(companion.delivered).toHaveLength(0);
    expect(inbox.delivered).toHaveLength(0);
  });

  it('falls through to the companion app when the glasses are offline', async () => {
    const { glasses, companion, inbox } = ladder();
    glasses.setOffline(true);

    const result = await deliverViaLadder([glasses, companion, inbox], PROMPT, OPTS);

    expect(result.delivered).toBe(true);
    if (result.delivered) expect(result.channel).toBe('companion-app');
    expect(result.attempts.map((a) => a.channel)).toEqual(['glasses', 'companion-app']);
    expect(inbox.delivered).toHaveLength(0);
  });

  it('reaches the web inbox when iOS refuses to wake the app', async () => {
    const { glasses, companion, inbox } = ladder();
    glasses.setDeliveryFailure('platform-denied-background-audio');
    companion.setDeliveryFailure('platform-denied-background-audio');

    const result = await deliverViaLadder([glasses, companion, inbox], PROMPT, OPTS);

    expect(result.delivered).toBe(true);
    if (result.delivered) expect(result.channel).toBe('web-inbox');
  });

  it('records every rung it tried, for the audit timeline', async () => {
    const { glasses, companion, inbox } = ladder();
    glasses.setOffline(true);
    companion.setDeliveryFailure('permission-denied');

    const result = await deliverViaLadder([glasses, companion, inbox], PROMPT, OPTS);

    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[0]?.outcome.status).toBe('undeliverable');
    expect(result.attempts[1]?.outcome.status).toBe('undeliverable');
    expect(result.attempts[2]?.outcome.status).toBe('presented');
  });
});

describe('when every rung refuses', () => {
  it('reports failure plainly rather than claiming delivery', async () => {
    const { glasses, companion, inbox } = ladder();
    for (const rung of [glasses, companion, inbox]) rung.setOffline(true);

    const result = await deliverViaLadder([glasses, companion, inbox], PROMPT, OPTS);

    expect(result.delivered).toBe(false);
    if (!result.delivered) {
      expect(result.reasons).toEqual([
        'device-unavailable',
        'device-unavailable',
        'device-unavailable',
      ]);
    }
  });

  it('fails when the ladder is the production adapter alone, since nothing is wired up', async () => {
    const result = await deliverViaLadder([createMetaWearableProductionAdapter()], PROMPT, OPTS);

    expect(result.delivered).toBe(false);
    if (!result.delivered) expect(result.reasons).toEqual(['capability-pending']);
  });

  it('leads to a deferral that owes the client an explanation and one follow-up', async () => {
    const { glasses, companion, inbox } = ladder();
    for (const rung of [glasses, companion, inbox]) rung.setOffline(true);

    const result = await deliverViaLadder([glasses, companion, inbox], PROMPT, OPTS);
    expect(result.delivered).toBe(false);

    // The whole point of the ladder failing cleanly: the orchestrator can turn
    // it into an honest outcome rather than leaving the caller on hold.
    const plan = planRecovery({
      dependency: 'wearable',
      conversationId: PROMPT.conversationId,
      escalationId: PROMPT.escalationId,
      clientStillConnected: true,
      callbackKnown: false,
      existingFollowUpKeys: [],
      detail: 'every delivery channel refused',
    });

    expect(plan.speakToClient).toBe(true);
    expect(plan.safeState).toBe('DEFERRED');
    expect(plan.createFollowUp).toBe(true);
    expect(plan.alert.severity).toBe('critical');
  });
});

describe('per-rung idempotency', () => {
  it('gives each channel its own key so descending is not mistaken for a retry', () => {
    expect(rungIdempotencyKey('deliver:esc-1', 'glasses')).not.toBe(
      rungIdempotencyKey('deliver:esc-1', 'web-inbox'),
    );
  });

  it('does not double-prompt when the whole ladder is retried', async () => {
    const { glasses, companion, inbox } = ladder();
    const rungs = [glasses, companion, inbox];

    await deliverViaLadder(rungs, PROMPT, OPTS);
    const retry = await deliverViaLadder(rungs, PROMPT, OPTS);

    expect(retry.delivered).toBe(true);
    expect(glasses.delivered).toHaveLength(1);
  });

  it('still reaches a lower rung after the one above it failed', async () => {
    const { glasses, companion } = ladder();
    glasses.setOffline(true);

    await deliverViaLadder([glasses, companion], PROMPT, OPTS);

    // Would silently break if both rungs shared one idempotency key.
    expect(companion.delivered).toHaveLength(1);
  });
});

describe('cancelling across the ladder', () => {
  it('withdraws the prompt from every rung so nobody answers a client who left', async () => {
    const { glasses, companion, inbox } = ladder();
    const rungs = [glasses, companion, inbox];
    glasses.setOffline(true);
    await deliverViaLadder(rungs, PROMPT, OPTS);

    await cancelAcrossLadder(rungs, 'esc-1', 'caller hung up');

    const events: FounderResponseEvent[] = [];
    companion.onFounderResponse((e) => events.push(e));
    const late = companion.founderAnswers('esc-1', 'Three weeks.');

    expect(late.accepted).toBe(false);
    expect(events).toEqual([]);
  });

  it('tells the remaining rungs even if one of them throws', async () => {
    const { companion } = ladder();
    const broken = {
      ...companion,
      channel: 'glasses' as const,
      cancelPrompt: () => Promise.reject(new Error('rung exploded')),
    };

    await deliverViaLadder([companion], PROMPT, OPTS);
    await expect(
      cancelAcrossLadder([broken, companion], 'esc-1', 'hung up'),
    ).resolves.toBeUndefined();

    expect(companion.founderAnswers('esc-1', 'late').accepted).toBe(false);
  });
});

describe('telephony outage recovers safely', () => {
  it('turns a mid-call provider outage into a deferral with a follow-up', async () => {
    const phone = createA1MobileSimulator();
    phone.incomingCall({ from: '+15550001', to: '+15559999' });
    const callId = phone.knownCalls()[0]!;

    phone.setOutage(true);
    const spoke = await phone.speak(
      { callId, text: 'Let me check with my boss.' },
      {
        idempotencyKey: 'speak-1',
        timeoutMs: 5_000,
        authorization: { grantedBy: 'policy', reference: 'decision-1' },
      },
    );

    expect(spoke.ok).toBe(false);

    const plan = planRecovery({
      dependency: 'telephony',
      conversationId: 'conv-1',
      escalationId: undefined,
      clientStillConnected: true,
      callbackKnown: false,
      existingFollowUpKeys: [],
      detail: spoke.ok ? '' : spoke.failure.kind,
    });

    expect(plan.safeState).toBe('DEFERRED');
    expect(plan.captureCallback).toBe(true);
    expect(plan.createFollowUp).toBe(true);
    expect(plan.reasons[0]).toContain('provider-outage');
    // No side effect was performed, so nothing to undo.
    expect(phone.commands).toHaveLength(0);
  });
});
