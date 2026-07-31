import { describe, expect, it } from 'vitest';
import { createMetaWearableSimulator } from './simulator.js';
import { createMetaWearableProductionAdapter } from './production.js';
import {
  META_WEARABLE_CAPABILITIES,
  type DeliveryOptions,
  type FounderResponseEvent,
  type WearablePrompt,
} from './contract.js';

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

function collect(sim: ReturnType<typeof createMetaWearableSimulator>) {
  const events: FounderResponseEvent[] = [];
  sim.onFounderResponse((e) => events.push(e));
  return events;
}

describe('capability honesty', () => {
  it('never claims a live capability', () => {
    for (const [name, status] of Object.entries(META_WEARABLE_CAPABILITIES)) {
      expect(status, `${name} must not claim to be live`).not.toBe('live');
    }
  });

  it('marks server-to-glasses push and custom wake words unsupported, not pending', () => {
    // These are not credentials problems. Meta documents that neither exists,
    // so no amount of access would flip them, and the console must say so.
    expect(META_WEARABLE_CAPABILITIES['delivery.serverToGlassesPush']).toBe('unsupported');
    expect(META_WEARABLE_CAPABILITIES['interaction.customWakeWord']).toBe('unsupported');
  });
});

describe('the production adapter refuses honestly', () => {
  it('reports a prompt as undeliverable rather than pretending it landed', async () => {
    const adapter = createMetaWearableProductionAdapter();
    const outcome = await adapter.deliverPrompt(PROMPT, OPTS);

    expect(outcome.status).toBe('undeliverable');
    if (outcome.status === 'undeliverable') expect(outcome.reason).toBe('capability-pending');
  });

  it('reports itself unreachable', async () => {
    const health = await createMetaWearableProductionAdapter().health();
    expect(health.reachable).toBe(false);
  });

  it('never fires a founder response, because no transport exists', async () => {
    const adapter = createMetaWearableProductionAdapter();
    const events: FounderResponseEvent[] = [];
    adapter.onFounderResponse((e) => events.push(e));

    await adapter.deliverPrompt(PROMPT, OPTS);
    expect(events).toEqual([]);
  });
});

describe('delivery requires positive acknowledgement', () => {
  it('presents a prompt and records when', async () => {
    const sim = createMetaWearableSimulator({ startAt: '2026-07-31T10:00:00.000Z' });
    const outcome = await sim.deliverPrompt(PROMPT, OPTS);

    expect(outcome.status).toBe('presented');
    if (outcome.status === 'presented') {
      expect(outcome.presentedAt).toBe('2026-07-31T10:00:00.000Z');
      expect(outcome.deduplicated).toBe(false);
    }
    expect(sim.outstanding()).toHaveLength(1);
  });

  it('reports device-unavailable when the glasses are offline', async () => {
    const sim = createMetaWearableSimulator();
    sim.setOffline(true);

    const outcome = await sim.deliverPrompt(PROMPT, OPTS);
    expect(outcome.status).toBe('undeliverable');
    if (outcome.status === 'undeliverable') expect(outcome.reason).toBe('device-unavailable');
    expect(sim.outstanding()).toHaveLength(0);
  });

  it('reproduces the documented iOS background-audio refusal', async () => {
    const sim = createMetaWearableSimulator();
    sim.setDeliveryFailure('platform-denied-background-audio');

    const outcome = await sim.deliverPrompt(PROMPT, OPTS);
    expect(outcome.status).toBe('undeliverable');
    if (outcome.status === 'undeliverable') {
      expect(outcome.reason).toBe('platform-denied-background-audio');
    }
  });

  it('leaves a failed delivery retryable, so the ladder can try again', async () => {
    const sim = createMetaWearableSimulator();
    sim.setOffline(true);
    await sim.deliverPrompt(PROMPT, OPTS);

    sim.setOffline(false);
    const retry = await sim.deliverPrompt(PROMPT, OPTS);

    expect(retry.status).toBe('presented');
  });

  it('does not prompt the founder twice for a retried delivery', async () => {
    const sim = createMetaWearableSimulator();
    const first = await sim.deliverPrompt(PROMPT, OPTS);
    const retry = await sim.deliverPrompt(PROMPT, OPTS);

    expect(first.status).toBe('presented');
    expect(retry.status).toBe('presented');
    if (retry.status === 'presented') expect(retry.deduplicated).toBe(true);
    expect(sim.delivered).toHaveLength(1);
  });
});

describe('founder responses', () => {
  it('carries an answer with its transcription confidence', async () => {
    const sim = createMetaWearableSimulator();
    const events = collect(sim);
    await sim.deliverPrompt(PROMPT, OPTS);

    sim.founderAnswers('esc-1', 'Three weeks, and tell her I said hello.', {
      transcriptionConfidence: 0.61,
    });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe('answered');
    if (event.kind === 'answered') {
      expect(event.text).toContain('Three weeks');
      // Narrowband capture means confidence has to survive to the policy gate.
      expect(event.transcriptionConfidence).toBe(0.61);
      expect(event.escalationId).toBe('esc-1');
      expect(event.channel).toBe('simulator');
    }
  });

  it('produces decline and defer without an answer', async () => {
    const sim = createMetaWearableSimulator();
    const events = collect(sim);

    await sim.deliverPrompt(PROMPT, OPTS);
    sim.founderDeclines('esc-1');

    await sim.deliverPrompt(
      { ...PROMPT, escalationId: 'esc-2' },
      { ...OPTS, idempotencyKey: 'k2' },
    );
    sim.founderDefers('esc-2');

    expect(events.map((e) => e.kind)).toEqual(['declined', 'deferred']);
    for (const event of events) expect(event).not.toHaveProperty('text');
  });

  it('produces took-call only from the explicit take-call action', async () => {
    const sim = createMetaWearableSimulator();
    const events = collect(sim);
    await sim.deliverPrompt(PROMPT, OPTS);

    // An answer whose words sound like consent is still just an answer.
    sim.founderAnswers('esc-1', 'Sure, put her through to me.');

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('answered');
    expect(events.some((e) => e.kind === 'took-call')).toBe(false);
  });

  it('produces took-call when the founder explicitly accepts', async () => {
    const sim = createMetaWearableSimulator();
    const events = collect(sim);
    await sim.deliverPrompt(PROMPT, OPTS);

    sim.founderTakesCall('esc-1');

    expect(events[0]?.kind).toBe('took-call');
  });

  it('has no way to report an expiry — that is the orchestrator’s timer', async () => {
    const sim = createMetaWearableSimulator();
    const events = collect(sim);

    await sim.deliverPrompt(PROMPT, OPTS);
    sim.advance(120_000); // long past expiresAt

    // A silent founder produces no event at all. The escalation times out in
    // the orchestrator, which is what stops a dead adapter stalling a client.
    expect(events).toEqual([]);
    expect(sim.outstanding()).toHaveLength(1);
  });
});

describe('late and stray responses are dropped', () => {
  it('refuses a response for an escalation it never delivered', () => {
    const sim = createMetaWearableSimulator();
    const events = collect(sim);

    const result = sim.founderAnswers('esc-unknown', 'anything');

    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.rejection).toBe('unknown-escalation');
    expect(events).toEqual([]);
  });

  it('refuses a second response to an already-answered escalation', async () => {
    const sim = createMetaWearableSimulator();
    const events = collect(sim);
    await sim.deliverPrompt(PROMPT, OPTS);

    sim.founderAnswers('esc-1', 'Three weeks.');
    const second = sim.founderAnswers('esc-1', 'Actually, four weeks.');

    expect(second.accepted).toBe(false);
    if (!second.accepted) expect(second.rejection).toBe('already-resolved');
    expect(events).toHaveLength(1);
  });

  it('drops a response that arrives after the prompt was withdrawn', async () => {
    const sim = createMetaWearableSimulator();
    const events = collect(sim);
    await sim.deliverPrompt(PROMPT, OPTS);

    await sim.cancelPrompt('esc-1', 'caller hung up');
    const late = sim.founderAnswers('esc-1', 'Three weeks.');

    // The client is gone; applying this would answer a conversation that moved on.
    expect(late.accepted).toBe(false);
    if (!late.accepted) expect(late.rejection).toBe('cancelled');
    expect(events).toEqual([]);
  });

  it('keeps two concurrent escalations apart', async () => {
    const sim = createMetaWearableSimulator();
    const events = collect(sim);

    await sim.deliverPrompt(PROMPT, OPTS);
    await sim.deliverPrompt(
      { ...PROMPT, escalationId: 'esc-2' },
      { ...OPTS, idempotencyKey: 'k2' },
    );

    sim.founderAnswers('esc-2', 'Tell them yes.');

    expect(events).toHaveLength(1);
    expect(events[0]?.escalationId).toBe('esc-2');
    expect(sim.outstanding().map((p) => p.escalationId)).toEqual(['esc-1']);
  });
});

describe('subscription and health', () => {
  it('stops delivering events after unsubscribe', async () => {
    const sim = createMetaWearableSimulator();
    const events: FounderResponseEvent[] = [];
    const unsubscribe = sim.onFounderResponse((e) => events.push(e));

    await sim.deliverPrompt(PROMPT, OPTS);
    unsubscribe();
    sim.founderAnswers('esc-1', 'Three weeks.');

    expect(events).toEqual([]);
  });

  it('reports unreachable while offline', async () => {
    const sim = createMetaWearableSimulator();
    expect((await sim.health()).reachable).toBe(true);

    sim.setOffline(true);
    expect((await sim.health()).reachable).toBe(false);
  });
});

describe('determinism', () => {
  it('moves time only when told to', () => {
    const sim = createMetaWearableSimulator({ startAt: '2026-07-31T10:00:00.000Z' });
    expect(sim.now()).toBe('2026-07-31T10:00:00.000Z');
    sim.advance(45_000);
    expect(sim.now()).toBe('2026-07-31T10:00:45.000Z');
  });

  it('produces identical events for identical scripts', async () => {
    async function script() {
      const sim = createMetaWearableSimulator({ startAt: '2026-07-31T10:00:00.000Z' });
      const events = collect(sim);
      await sim.deliverPrompt(PROMPT, OPTS);
      sim.advance(3_000);
      sim.founderAnswers('esc-1', 'Three weeks.');
      return events;
    }

    expect(await script()).toEqual(await script());
  });
});
