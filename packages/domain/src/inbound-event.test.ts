import { describe, expect, it } from 'vitest';
import {
  createEnvelope,
  decideIngest,
  deriveIdempotencyKey,
  deriveSideEffectKey,
  type EnvelopeInput,
  type IngestContext,
  type InboundEventEnvelope,
} from './inbound-event.js';

const RAW = { storageKey: 'raw/a1mobile/evt-1.json', contentHash: 'abc123', byteLength: 412 };

function input(overrides: Partial<EnvelopeInput> = {}): EnvelopeInput {
  return {
    traceId: 'trace-1',
    provider: 'a1mobile',
    providerEventId: 'CA-evt-1',
    kind: 'call.answered',
    conversationId: 'conv-1',
    receivedAt: '2026-07-31T10:00:00.000Z',
    rawEventRef: RAW,
    ...overrides,
  };
}

function envelope(overrides: Partial<EnvelopeInput> = {}): InboundEventEnvelope {
  const result = createEnvelope(input(overrides));
  if (!result.ok) throw new Error(`fixture should be valid: ${result.message}`);
  return result.envelope;
}

const NO_HISTORY: IngestContext = { priorDelivery: undefined, highWaterMark: undefined };

describe('envelope validation', () => {
  it('accepts a well-formed event', () => {
    const result = createEnvelope(input());
    expect(result.ok).toBe(true);
  });

  it('refuses an event with no provider event id, because it could not be deduplicated', () => {
    const result = createEnvelope(input({ providerEventId: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-provider-event-id');
  });

  it('refuses an event with no raw-event reference, so every decision stays traceable', () => {
    const result = createEnvelope(
      input({ rawEventRef: { storageKey: '', contentHash: '', byteLength: 0 } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-raw-event-ref');
  });

  it('refuses an event with no trace id or no kind', () => {
    expect(createEnvelope(input({ traceId: '' })).ok).toBe(false);
    expect(createEnvelope(input({ kind: '' })).ok).toBe(false);
  });
});

describe('idempotency key derivation', () => {
  it('is stable across redeliveries of the same provider event', () => {
    const first = envelope({ traceId: 'trace-1', receivedAt: '2026-07-31T10:00:00.000Z' });
    const redelivery = envelope({ traceId: 'trace-2', receivedAt: '2026-07-31T10:00:09.000Z' });

    expect(redelivery.idempotencyKey).toBe(first.idempotencyKey);
    expect(redelivery.traceId).not.toBe(first.traceId);
  });

  it('does not depend on payload content, so a cosmetically different retry is still the same event', () => {
    const original = envelope({ rawEventRef: RAW });
    const retryWithExtraField = envelope({
      rawEventRef: {
        storageKey: 'raw/a1mobile/evt-1-retry.json',
        contentHash: 'zzz999',
        byteLength: 460,
      },
    });

    expect(retryWithExtraField.idempotencyKey).toBe(original.idempotencyKey);
  });

  it('separates providers, so two providers reusing an id do not collide', () => {
    expect(deriveIdempotencyKey('a1mobile', 'evt-1')).not.toBe(
      deriveIdempotencyKey('meta-wearable', 'evt-1'),
    );
  });

  it('stays unambiguous when the provider event id itself contains the separator', () => {
    // Splitting on the FIRST colon is always correct because no ProviderId
    // contains one. Without that property these two would collide.
    const a = deriveIdempotencyKey('a1mobile', 'urn:evt:1');
    const b = deriveIdempotencyKey('a1mobile', 'urn:evt:2');
    expect(a).not.toBe(b);
    expect(a.slice(0, a.indexOf(':'))).toBe('a1mobile');
  });
});

describe('duplicate delivery', () => {
  it('skips a redelivered event outright, so no side effect is even attempted', () => {
    const first = envelope({ traceId: 'trace-1' });
    const firstDecision = decideIngest(first, NO_HISTORY);
    expect(firstDecision.kind).toBe('process');

    const redelivery = envelope({ traceId: 'trace-2', receivedAt: '2026-07-31T10:00:09.000Z' });
    const secondDecision = decideIngest(redelivery, {
      priorDelivery: {
        idempotencyKey: first.idempotencyKey,
        traceId: first.traceId,
        receivedAt: first.receivedAt,
      },
      highWaterMark: undefined,
    });

    expect(secondDecision.kind).toBe('skip');
    if (secondDecision.kind === 'skip') {
      expect(secondDecision.reason).toBe('duplicate');
      // Points back at the delivery that actually did the work.
      expect(secondDecision.originalTraceId).toBe('trace-1');
      expect(secondDecision.firstSeenAt).toBe('2026-07-31T10:00:00.000Z');
    }
  });

  it('processes a genuinely different event from the same provider', () => {
    const first = envelope({ providerEventId: 'CA-evt-1' });
    const second = envelope({ providerEventId: 'CA-evt-2' });

    const decision = decideIngest(second, {
      priorDelivery: {
        idempotencyKey: first.idempotencyKey,
        traceId: 'trace-1',
        receivedAt: first.receivedAt,
      },
      highWaterMark: undefined,
    });

    expect(decision.kind).toBe('process');
  });
});

describe('out-of-order delivery', () => {
  it('flags an event that arrives behind the high-water mark but still processes it', () => {
    const late = envelope({ providerEventId: 'CA-evt-1', sequence: 3 });
    const decision = decideIngest(late, { priorDelivery: undefined, highWaterMark: 7 });

    expect(decision.kind).toBe('process');
    if (decision.kind === 'process') expect(decision.outOfOrder).toBe(true);
  });

  it('does not flag an in-order event', () => {
    const next = envelope({ sequence: 8 });
    const decision = decideIngest(next, { priorDelivery: undefined, highWaterMark: 7 });

    expect(decision.kind).toBe('process');
    if (decision.kind === 'process') expect(decision.outOfOrder).toBe(false);
  });

  it('does not flag anything when the provider supplies no sequence at all', () => {
    const decision = decideIngest(envelope({ sequence: undefined }), {
      priorDelivery: undefined,
      highWaterMark: 7,
    });

    expect(decision.kind).toBe('process');
    if (decision.kind === 'process') expect(decision.outOfOrder).toBe(false);
  });

  it('treats a duplicate as a duplicate even when it is also out of order', () => {
    const env = envelope({ sequence: 2 });
    const decision = decideIngest(env, {
      priorDelivery: {
        idempotencyKey: env.idempotencyKey,
        traceId: 'trace-1',
        receivedAt: env.receivedAt,
      },
      highWaterMark: 9,
    });

    // Skipping must win: a duplicate is never processed, ordering or not.
    expect(decision.kind).toBe('skip');
  });
});

describe('side-effect keys — the guarantee that actually prevents double sends', () => {
  it('produces identical keys when the same inbound event is reprocessed', () => {
    const first = envelope({ traceId: 'trace-1' });
    const replay = envelope({ traceId: 'trace-2', receivedAt: '2026-08-01T09:00:00.000Z' });

    for (const kind of [
      'send-sms',
      'transfer-call',
      'create-follow-up',
      'create-booking',
    ] as const) {
      expect(deriveSideEffectKey(replay.idempotencyKey, kind)).toBe(
        deriveSideEffectKey(first.idempotencyKey, kind),
      );
    }
  });

  it('gives each side effect of one event a distinct key', () => {
    const key = envelope().idempotencyKey;
    const keys = [
      deriveSideEffectKey(key, 'send-sms'),
      deriveSideEffectKey(key, 'transfer-call'),
      deriveSideEffectKey(key, 'create-booking'),
      deriveSideEffectKey(key, 'create-follow-up'),
      deriveSideEffectKey(key, 'deliver-founder-prompt'),
      deriveSideEffectKey(key, 'publish-knowledge-proposal'),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('separates two side effects of the same kind via a deterministic discriminator', () => {
    const key = envelope().idempotencyKey;
    const toAlice = deriveSideEffectKey(key, 'send-sms', '+15550001');
    const toBob = deriveSideEffectKey(key, 'send-sms', '+15550002');

    expect(toAlice).not.toBe(toBob);
    // Same discriminator, same key — that is the whole point.
    expect(deriveSideEffectKey(key, 'send-sms', '+15550001')).toBe(toAlice);
  });

  it('treats an empty discriminator as none, rather than as a distinct value', () => {
    const key = envelope().idempotencyKey;
    expect(deriveSideEffectKey(key, 'send-sms', '')).toBe(deriveSideEffectKey(key, 'send-sms'));
  });

  it('never collides a follow-up across two different inbound events', () => {
    const a = envelope({ providerEventId: 'CA-evt-1' }).idempotencyKey;
    const b = envelope({ providerEventId: 'CA-evt-2' }).idempotencyKey;

    expect(deriveSideEffectKey(a, 'create-follow-up')).not.toBe(
      deriveSideEffectKey(b, 'create-follow-up'),
    );
  });
});

describe('purity', () => {
  it('returns the same decision for the same input every time', () => {
    const env = envelope({ sequence: 3 });
    const ctx: IngestContext = { priorDelivery: undefined, highWaterMark: 7 };
    expect(decideIngest(env, ctx)).toEqual(decideIngest(env, ctx));
  });

  it('does not mutate the envelope it was given', () => {
    const env = envelope({ sequence: 3 });
    const pristine = envelope({ sequence: 3 });

    decideIngest(env, { priorDelivery: undefined, highWaterMark: 7 });

    expect(env).toEqual(pristine);
  });
});
