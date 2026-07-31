/**
 * The inbound provider event envelope.
 *
 * Every event arriving from a provider is wrapped in one of these before the
 * orchestrator touches it. The envelope is what makes CLAUDE.md's idempotency
 * rule enforceable: a duplicate webhook must never produce a second message,
 * transfer, booking, or follow-up.
 *
 * Two distinct mechanisms live here, and they protect against different things:
 *
 *  1. **Envelope dedupe** — has this exact provider event been seen before? A
 *     repeat is skipped outright, so no side effect is even attempted.
 *  2. **Side-effect keys** — derived deterministically from the envelope, so
 *     that if an event *is* reprocessed (a crash mid-flight, a manual replay,
 *     a race between two workers) the provider sees the same idempotency key
 *     and dedupes on its side.
 *
 * The second is the one that actually saves you, because the first depends on
 * having durably recorded the event before doing anything with it.
 *
 * Pure by construction: no clock, no hashing, no I/O. Timestamps and content
 * hashes are computed by the adapter and passed in.
 */

/** Closed set — deliberately colon-free, see `deriveIdempotencyKey`. */
export type ProviderId = 'a1mobile' | 'meta-wearable';

/**
 * A pointer to the raw provider payload, stored verbatim elsewhere (Supabase
 * Storage or an events table). CLAUDE.md requires a raw-event reference so any
 * decision can be traced back to exactly what the provider sent.
 *
 * The hash is computed by the adapter — the domain cannot hash, because that
 * would mean importing node:crypto and giving up determinism guarantees.
 */
export interface RawEventRef {
  readonly storageKey: string;
  /** Hex digest of the raw bytes, for tamper-evidence and debugging. */
  readonly contentHash: string;
  readonly byteLength: number;
}

export interface InboundEventEnvelope {
  /** Correlates every action caused by this delivery. New on each delivery. */
  readonly traceId: string;
  readonly provider: ProviderId;
  /**
   * The provider's own event identifier, opaque to us — Twilio `CallSid` /
   * `MessageSid`, Telnyx event `id`, or whatever a1mobile turns out to use.
   * Extracted by a per-provider mapper so swapping providers does not
   * invalidate previously stored keys.
   *
   * If a provider genuinely emits no stable event ID, its adapter must
   * synthesise a deterministic one (e.g. from the payload hash) before
   * building an envelope. It must never be left blank: a blank id would
   * collapse every event onto one key and silently discard real traffic.
   */
  readonly providerEventId: string;
  /** Provider-specific event name, e.g. 'call.answered'. */
  readonly kind: string;
  readonly conversationId: string | undefined;
  /** When we received it. Injected — the domain does not read a clock. */
  readonly receivedAt: string;
  /**
   * Provider-assigned ordering within a conversation, where the provider
   * offers one. Used only to flag out-of-order arrival; it is never the
   * authority on whether an event is legal — the state machine is.
   */
  readonly sequence: number | undefined;
  readonly rawEventRef: RawEventRef;
  /** Derived, stable across redeliveries of the same provider event. */
  readonly idempotencyKey: string;
}

export type EnvelopeRejectionReason =
  'missing-provider-event-id' | 'missing-trace-id' | 'missing-kind' | 'invalid-raw-event-ref';

export type EnvelopeResult =
  | { readonly ok: true; readonly envelope: InboundEventEnvelope }
  | { readonly ok: false; readonly reason: EnvelopeRejectionReason; readonly message: string };

export interface EnvelopeInput {
  readonly traceId: string;
  readonly provider: ProviderId;
  readonly providerEventId: string;
  readonly kind: string;
  readonly conversationId?: string | undefined;
  readonly receivedAt: string;
  readonly sequence?: number | undefined;
  readonly rawEventRef: RawEventRef;
}

const KEY_SEPARATOR = ':';

/**
 * `provider:providerEventId`.
 *
 * Unambiguous because `ProviderId` is a closed union with no colon in it, so
 * the first colon is always the boundary — the provider event ID may contain
 * anything, including colons, without risking a collision with a different
 * provider's key.
 *
 * Derived from identifiers rather than payload content on purpose: a provider
 * that retries with a cosmetically different body (added field, reordered
 * JSON) is still the same event, and content hashing would treat it as new.
 */
export function deriveIdempotencyKey(provider: ProviderId, providerEventId: string): string {
  return `${provider}${KEY_SEPARATOR}${providerEventId}`;
}

export function createEnvelope(input: EnvelopeInput): EnvelopeResult {
  if (input.providerEventId.trim() === '') {
    return {
      ok: false,
      reason: 'missing-provider-event-id',
      message:
        'Refusing an event with no provider event id — it cannot be deduplicated, and a blank id would collapse every event onto one key.',
    };
  }
  if (input.traceId.trim() === '') {
    return { ok: false, reason: 'missing-trace-id', message: 'Every delivery needs a trace id.' };
  }
  if (input.kind.trim() === '') {
    return { ok: false, reason: 'missing-kind', message: 'Every event needs a kind.' };
  }
  if (input.rawEventRef.storageKey.trim() === '' || input.rawEventRef.contentHash.trim() === '') {
    return {
      ok: false,
      reason: 'invalid-raw-event-ref',
      message:
        'Every event needs a raw-event reference so a decision can be traced back to what the provider actually sent.',
    };
  }

  return {
    ok: true,
    envelope: {
      traceId: input.traceId,
      provider: input.provider,
      providerEventId: input.providerEventId,
      kind: input.kind,
      conversationId: input.conversationId,
      receivedAt: input.receivedAt,
      sequence: input.sequence,
      rawEventRef: input.rawEventRef,
      idempotencyKey: deriveIdempotencyKey(input.provider, input.providerEventId),
    },
  };
}

/** What we already know about a previously accepted delivery. */
export interface DeliveryRecord {
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly receivedAt: string;
}

export interface IngestContext {
  /** A prior accepted delivery of this exact idempotency key, if any. */
  readonly priorDelivery: DeliveryRecord | undefined;
  /** Highest provider sequence already processed on this conversation. */
  readonly highWaterMark: number | undefined;
}

export type IngestDecision =
  | {
      readonly kind: 'process';
      readonly idempotencyKey: string;
      /**
       * Arrived after a higher-sequenced sibling. Advisory only: the event is
       * still processed, because the state machine — not the provider's
       * ordering — is the authority on what is legal. A late `call.answered`
       * after a hangup is simply rejected there, which is the correct outcome
       * and is already an audit event.
       */
      readonly outOfOrder: boolean;
    }
  | {
      readonly kind: 'skip';
      readonly reason: 'duplicate';
      readonly idempotencyKey: string;
      /** Trace id of the delivery that did the work, for the audit trail. */
      readonly originalTraceId: string;
      readonly firstSeenAt: string;
    };

/**
 * Decide whether to act on a delivery.
 *
 * Duplicates are skipped hard — no side effect is attempted at all. Ordering
 * anomalies are flagged but still processed, because dropping a late event
 * risks losing real information (a hangup, a founder answer) whereas acting on
 * an illegal one is already safely rejected downstream.
 */
export function decideIngest(
  envelope: InboundEventEnvelope,
  context: IngestContext,
): IngestDecision {
  const { priorDelivery, highWaterMark } = context;

  if (priorDelivery?.idempotencyKey === envelope.idempotencyKey) {
    return {
      kind: 'skip',
      reason: 'duplicate',
      idempotencyKey: envelope.idempotencyKey,
      originalTraceId: priorDelivery.traceId,
      firstSeenAt: priorDelivery.receivedAt,
    };
  }

  const outOfOrder =
    envelope.sequence !== undefined &&
    highWaterMark !== undefined &&
    envelope.sequence < highWaterMark;

  return { kind: 'process', idempotencyKey: envelope.idempotencyKey, outOfOrder };
}

/**
 * Side effects that must never happen twice for one inbound event.
 * CLAUDE.md names messages, transfers, bookings, and follow-ups explicitly.
 */
export type SideEffectKind =
  | 'send-sms'
  | 'transfer-call'
  | 'create-booking'
  | 'create-follow-up'
  | 'deliver-founder-prompt'
  | 'publish-knowledge-proposal';

/**
 * Derive the idempotency key handed to a provider when performing a side
 * effect, so a replay of the same inbound event produces the same key and the
 * provider dedupes it.
 *
 * The discriminator distinguishes two side effects of the same kind caused by
 * one event (two recipients, say) and **must be deterministic** — derive it
 * from the data, never from a counter, a timestamp, or insertion order, or the
 * key stops being stable across a replay and the guarantee evaporates.
 */
export function deriveSideEffectKey(
  envelopeIdempotencyKey: string,
  kind: SideEffectKind,
  discriminator?: string,
): string {
  const base = `${envelopeIdempotencyKey}#${kind}`;
  return discriminator === undefined || discriminator === '' ? base : `${base}#${discriminator}`;
}
