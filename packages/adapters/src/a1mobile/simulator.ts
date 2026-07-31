/**
 * A1MobileSimulator — a deterministic stand-in for the a1mobile provider.
 *
 * It exists so local development and tests never depend on live provider
 * access. It is emphatically **not** a way to ship a feature that does not
 * work: it implements the same contract and emits the same domain events, so
 * code exercised against it is the code that will run against a real provider.
 *
 * It does not shortcut the pipeline. Simulated events come out as signed
 * `RawWebhookDelivery` objects that callers feed through `verifyAndParse`,
 * exactly as a real webhook would arrive — so verification, envelope
 * construction, and deduplication are all genuinely exercised.
 *
 * Deterministic by construction: the clock only moves when a test advances it,
 * and identifiers come from counters rather than randomness. Two runs of the
 * same script produce byte-identical output.
 */

import {
  A1MOBILE_CAPABILITIES,
  type A1MobileAdapter,
  type A1MobileCapability,
  type A1MobilePayload,
  type CallEndReason,
  type CommandAck,
  type CommandContext,
  type CommandResult,
  type DeliveryContext,
  type GatherInput,
  type RawWebhookDelivery,
  type SendSmsInput,
  type SentSms,
  type SmsDeliveryStatus,
  type SpeakInput,
  type TransferInput,
  type VerificationResult,
} from './contract.js';
import type { CapabilityRegistry } from '../capability.js';

const SIGNATURE_HEADER = 'x-a1mobile-signature';

/**
 * Deterministic digest for simulated webhook signatures.
 *
 * FNV-1a, not a cryptographic MAC. The simulator's job is to exercise the
 * verification code path so a real signing scheme drops in without changing
 * callers — it is not to be secure, and it never guards anything real.
 */
function digest(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface RecordedCommand {
  readonly kind: A1MobileCapability;
  readonly idempotencyKey: string;
  readonly at: string;
  readonly authorizedBy: string;
  readonly detail: Readonly<Record<string, string>>;
}

export interface SimulatorOptions {
  readonly startAt?: string;
  readonly signingSecret?: string;
}

export interface A1MobileSimulator extends A1MobileAdapter {
  // --- clock ---------------------------------------------------------------
  now(): string;
  advance(ms: number): void;

  // --- fault injection -----------------------------------------------------
  /** While down, every command fails with a retryable provider-outage. */
  setOutage(down: boolean): void;

  // --- observation ---------------------------------------------------------
  /** Side effects actually performed. A deduplicated retry does not appear. */
  readonly commands: readonly RecordedCommand[];

  // --- event production ----------------------------------------------------
  incomingCall(input: { readonly from: string; readonly to: string }): RawWebhookDelivery;
  callAnswered(callId: string): RawWebhookDelivery;
  callerSaid(input: {
    readonly callId: string;
    readonly text: string;
    readonly confidence?: number;
    readonly isFinal?: boolean;
  }): RawWebhookDelivery;
  callEnded(callId: string, reason: CallEndReason): RawWebhookDelivery;
  inboundSms(input: {
    readonly from: string;
    readonly to: string;
    readonly body: string;
  }): RawWebhookDelivery;
  smsStatus(messageId: string, status: SmsDeliveryStatus): RawWebhookDelivery;
  recordingReady(callId: string, recordingRef: string): RawWebhookDelivery;

  /**
   * The identical delivery again — a duplicate webhook, byte for byte, with
   * the same provider event id. Feeding this back through `verifyAndParse`
   * yields the same idempotency key, which is what the domain deduplicates on.
   *
   * Out-of-order delivery needs no special API: hold onto several deliveries
   * and feed them in whatever order you like. Each carries the sequence number
   * it was created with.
   */
  redeliver(delivery: RawWebhookDelivery): RawWebhookDelivery;

  /** Call ids the simulator currently knows about. */
  knownCalls(): readonly string[];
}

interface EventBody {
  readonly eventId: string;
  readonly sequence: number;
  readonly emittedAt: string;
  readonly payload: A1MobilePayload;
}

export function createA1MobileSimulator(options: SimulatorOptions = {}): A1MobileSimulator {
  const secret = options.signingSecret ?? 'simulator-secret';
  let currentMs = new Date(options.startAt ?? '2026-07-31T10:00:00.000Z').getTime();

  let eventCounter = 0;
  let callCounter = 0;
  let messageCounter = 0;
  let commandCounter = 0;
  let sequence = 0;
  let outage = false;

  const activeCalls = new Set<string>();
  const performed: RecordedCommand[] = [];
  const seenKeys = new Map<string, unknown>();

  function now(): string {
    return new Date(currentMs).toISOString();
  }

  function sign(body: string): string {
    return digest(`${secret}.${body}`);
  }

  function emit(payload: A1MobilePayload): RawWebhookDelivery {
    eventCounter += 1;
    sequence += 1;
    const body: EventBody = {
      eventId: `sim-evt-${String(eventCounter)}`,
      sequence,
      emittedAt: now(),
      payload,
    };
    const serialized = JSON.stringify(body);
    return {
      body: serialized,
      headers: { [SIGNATURE_HEADER]: sign(serialized) },
      rawEventRef: {
        storageKey: `raw/a1mobile/${body.eventId}.json`,
        contentHash: digest(serialized),
        byteLength: serialized.length,
      },
    };
  }

  /**
   * Commands are idempotent on their key: a repeat returns the original
   * outcome and performs nothing. This is the behaviour a real provider offers
   * and the reason a duplicate webhook cannot double-send.
   */
  function perform<T>(
    capability: A1MobileCapability,
    context: CommandContext,
    detail: Readonly<Record<string, string>>,
    value: T,
  ): CommandResult<T> {
    if (seenKeys.has(context.idempotencyKey)) {
      return { ok: true, value: seenKeys.get(context.idempotencyKey) as T, deduplicated: true };
    }
    if (outage) {
      return {
        ok: false,
        failure: {
          kind: 'provider-outage',
          message: 'The simulated provider is unavailable.',
          retryable: true,
        },
      };
    }

    seenKeys.set(context.idempotencyKey, value);
    performed.push({
      kind: capability,
      idempotencyKey: context.idempotencyKey,
      at: now(),
      authorizedBy: `${context.authorization.grantedBy}:${context.authorization.reference}`,
      detail,
    });
    return { ok: true, value, deduplicated: false };
  }

  function nextAck(): CommandAck {
    commandCounter += 1;
    return { providerRef: `sim-cmd-${String(commandCounter)}` };
  }

  function requireCall<T>(callId: string): CommandResult<T> | undefined {
    if (activeCalls.has(callId)) return undefined;
    return {
      ok: false,
      failure: { kind: 'unknown-call', message: `No active call ${callId}.` },
    };
  }

  const capabilities: CapabilityRegistry<A1MobileCapability> = A1MOBILE_CAPABILITIES;

  return {
    capabilities,

    now,
    advance(ms: number) {
      currentMs += ms;
    },
    setOutage(down: boolean) {
      outage = down;
    },
    get commands() {
      return performed;
    },
    knownCalls() {
      return [...activeCalls];
    },

    // --- inbound -----------------------------------------------------------

    verifyAndParse(delivery: RawWebhookDelivery, context: DeliveryContext): VerificationResult {
      const provided = delivery.headers[SIGNATURE_HEADER];
      if (provided !== sign(delivery.body)) {
        return {
          ok: false,
          failure: { kind: 'bad-signature', message: 'Signature did not match the body.' },
        };
      }

      let parsed: EventBody;
      try {
        parsed = JSON.parse(delivery.body) as EventBody;
      } catch {
        return {
          ok: false,
          failure: { kind: 'unparseable', message: 'Body was not valid JSON.' },
        };
      }

      return {
        ok: true,
        event: {
          envelope: {
            traceId: context.traceId,
            provider: 'a1mobile',
            providerEventId: parsed.eventId,
            kind: parsed.payload.kind,
            receivedAt: context.receivedAt,
            sequence: parsed.sequence,
            rawEventRef: delivery.rawEventRef,
          },
          payload: parsed.payload,
        },
      };
    },

    incomingCall(input) {
      callCounter += 1;
      const callId = `sim-call-${String(callCounter)}`;
      activeCalls.add(callId);
      return emit({ kind: 'call.incoming', callId, from: input.from, to: input.to });
    },
    callAnswered(callId) {
      return emit({ kind: 'call.answered', callId });
    },
    callerSaid(input) {
      return emit({
        kind: 'transcript.segment',
        callId: input.callId,
        text: input.text,
        confidence: input.confidence ?? 0.95,
        isFinal: input.isFinal ?? true,
      });
    },
    callEnded(callId, reason) {
      activeCalls.delete(callId);
      return emit({ kind: 'call.ended', callId, reason });
    },
    inboundSms(input) {
      messageCounter += 1;
      return emit({
        kind: 'sms.inbound',
        messageId: `sim-msg-${String(messageCounter)}`,
        from: input.from,
        to: input.to,
        body: input.body,
      });
    },
    smsStatus(messageId, status) {
      return emit({ kind: 'sms.status', messageId, status });
    },
    recordingReady(callId, recordingRef) {
      return emit({ kind: 'recording.ready', callId, recordingRef });
    },
    redeliver(delivery) {
      return delivery;
    },

    // --- outbound ----------------------------------------------------------

    answerCall(callId: string, context: CommandContext) {
      const missing = requireCall<CommandAck>(callId);
      if (missing) return Promise.resolve(missing);
      return Promise.resolve(perform('call.answer', context, { callId }, nextAck()));
    },
    speak(input: SpeakInput, context: CommandContext) {
      const missing = requireCall<CommandAck>(input.callId);
      if (missing) return Promise.resolve(missing);
      return Promise.resolve(
        perform('call.speak', context, { callId: input.callId, text: input.text }, nextAck()),
      );
    },
    gather(input: GatherInput, context: CommandContext) {
      const missing = requireCall<CommandAck>(input.callId);
      if (missing) return Promise.resolve(missing);
      return Promise.resolve(
        perform('call.gather', context, { callId: input.callId, prompt: input.prompt }, nextAck()),
      );
    },
    hold(callId: string, context: CommandContext) {
      const missing = requireCall<CommandAck>(callId);
      if (missing) return Promise.resolve(missing);
      return Promise.resolve(perform('call.hold', context, { callId }, nextAck()));
    },
    resume(callId: string, context: CommandContext) {
      const missing = requireCall<CommandAck>(callId);
      if (missing) return Promise.resolve(missing);
      return Promise.resolve(
        perform('call.hold', context, { callId, action: 'resume' }, nextAck()),
      );
    },
    transferCall(input: TransferInput, context: CommandContext) {
      const missing = requireCall<CommandAck>(input.callId);
      if (missing) return Promise.resolve(missing);
      return Promise.resolve(
        perform(
          'call.transfer',
          context,
          { callId: input.callId, to: input.to, mode: input.mode },
          nextAck(),
        ),
      );
    },
    terminateCall(callId: string, reason: CallEndReason, context: CommandContext) {
      const missing = requireCall<CommandAck>(callId);
      if (missing) return Promise.resolve(missing);
      const result = perform('call.terminate', context, { callId, reason }, nextAck());
      if (result.ok && !result.deduplicated) activeCalls.delete(callId);
      return Promise.resolve(result);
    },
    sendSms(input: SendSmsInput, context: CommandContext) {
      messageCounter += 1;
      const providerMessageId = `sim-msg-${String(messageCounter)}`;
      return Promise.resolve(
        perform<SentSms>(
          'sms.send',
          context,
          { to: input.to, body: input.body },
          {
            ...nextAck(),
            providerMessageId,
          },
        ),
      );
    },
  };
}
