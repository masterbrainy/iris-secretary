/**
 * The a1mobile adapter contract.
 *
 * a1mobile publishes no developer API (docs/architecture.md §2), so this
 * contract is specified against the union of two fully documented CPaaS
 * lifecycles — Twilio Programmable Voice and Telnyx Call Control — because
 * that is the shape any telephony provider would have to satisfy.
 *
 * **No a1mobile endpoint is asserted anywhere in this file.** Referencing
 * public vendor documentation to design our own interface is not the same as
 * inventing a provider endpoint, which CLAUDE.md forbids outright.
 *
 * The shape is the async command/webhook model (Telnyx-style), not the
 * synchronous TwiML request-response model. Iris's core flow — hold the
 * client, ask the founder, come back with an answer — is inherently
 * asynchronous and multi-turn, and a request-response shape would fight it.
 */

import type { EnvelopeInput, RawEventRef } from '@iris/domain';
import type { CapabilityRegistry } from '../capability.js';

/** Every capability starts pending. Nothing here is backed by a live provider. */
export const A1MOBILE_CAPABILITIES = {
  'call.answer': 'pending',
  'call.speak': 'pending',
  'call.gather': 'pending',
  'call.hold': 'pending',
  'call.transfer': 'pending',
  'call.terminate': 'pending',
  'sms.send': 'pending',
  'webhook.verify': 'pending',
} as const satisfies CapabilityRegistry;

export type A1MobileCapability = keyof typeof A1MOBILE_CAPABILITIES;

// ---------------------------------------------------------------------------
// Inbound: what the provider tells us
// ---------------------------------------------------------------------------

export type CallEndReason = 'completed' | 'caller-hung-up' | 'busy' | 'no-answer' | 'failed';

export type SmsDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';

/**
 * Provider payloads, normalised. Each arrives wrapped in an envelope so the
 * domain can deduplicate it before anything acts on it.
 */
export type A1MobilePayload =
  | {
      readonly kind: 'call.incoming';
      readonly callId: string;
      readonly from: string;
      readonly to: string;
    }
  | { readonly kind: 'call.answered'; readonly callId: string }
  | { readonly kind: 'call.ended'; readonly callId: string; readonly reason: CallEndReason }
  | {
      readonly kind: 'transcript.segment';
      readonly callId: string;
      readonly text: string;
      /** 0..1. Feeds the policy gate that confirms poorly-heard details. */
      readonly confidence: number;
      readonly isFinal: boolean;
    }
  | {
      readonly kind: 'sms.inbound';
      readonly messageId: string;
      readonly from: string;
      readonly to: string;
      readonly body: string;
    }
  | {
      readonly kind: 'sms.status';
      readonly messageId: string;
      readonly status: SmsDeliveryStatus;
    }
  | { readonly kind: 'recording.ready'; readonly callId: string; readonly recordingRef: string };

/** A webhook delivery exactly as it arrived, before we trust any of it. */
export interface RawWebhookDelivery {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Where the raw bytes were persisted, so decisions stay traceable. */
  readonly rawEventRef: RawEventRef;
}

/**
 * Supplied by the HTTP layer, which is where impurity belongs: generating a
 * trace id and reading the clock are both things the adapter must not do, so
 * that the adapter and the simulator stay deterministic and testable.
 */
export interface DeliveryContext {
  readonly traceId: string;
  readonly receivedAt: string;
}

export interface VerifiedInboundEvent {
  /** Ready to hand to `createEnvelope` in the domain. */
  readonly envelope: EnvelopeInput;
  readonly payload: A1MobilePayload;
}

export type VerificationFailure =
  | { readonly kind: 'bad-signature'; readonly message: string }
  | { readonly kind: 'unparseable'; readonly message: string }
  | { readonly kind: 'unsupported-event'; readonly message: string }
  | {
      readonly kind: 'capability-pending';
      readonly capability: A1MobileCapability;
      readonly message: string;
    };

export type VerificationResult =
  | { readonly ok: true; readonly event: VerifiedInboundEvent }
  | { readonly ok: false; readonly failure: VerificationFailure };

// ---------------------------------------------------------------------------
// Outbound: commands we issue
// ---------------------------------------------------------------------------

/**
 * Who authorised this side effect. CLAUDE.md requires every side effect to
 * carry authorization, and the audit timeline has to be able to answer
 * "why did Iris send that?" months later.
 */
export interface Authorization {
  readonly grantedBy: 'policy' | 'founder' | 'operator';
  /** The policy decision, escalation, or operator action that granted it. */
  readonly reference: string;
}

/** Every side effect: typed input, authorization, timeout, idempotency key. */
export interface CommandContext {
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
  readonly authorization: Authorization;
}

export type CommandFailure =
  | {
      readonly kind: 'capability-pending';
      readonly capability: A1MobileCapability;
      readonly message: string;
    }
  | { readonly kind: 'provider-outage'; readonly message: string; readonly retryable: true }
  | { readonly kind: 'timeout'; readonly message: string; readonly retryable: true }
  | { readonly kind: 'unknown-call'; readonly message: string }
  | { readonly kind: 'invalid-request'; readonly message: string };

export type CommandResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      /**
       * True when this exact idempotency key was already used and the provider
       * (or the simulator) returned the original result instead of repeating
       * the side effect. A duplicate webhook must never double-send.
       */
      readonly deduplicated: boolean;
    }
  | { readonly ok: false; readonly failure: CommandFailure };

/**
 * What a command returns on success. A provider-side reference is worth having
 * even when the command itself produces nothing: the audit timeline needs
 * something to correlate against provider logs months later.
 */
export interface CommandAck {
  readonly providerRef: string;
}

export interface SentSms extends CommandAck {
  readonly providerMessageId: string;
}

export interface SpeakInput {
  readonly callId: string;
  readonly text: string;
}

export interface GatherInput {
  readonly callId: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface TransferInput {
  readonly callId: string;
  readonly to: string;
  /** Warm keeps Iris on the line to introduce; blind hands straight over. */
  readonly mode: 'warm' | 'blind';
}

export interface SendSmsInput {
  readonly to: string;
  readonly from: string;
  readonly body: string;
}

export interface A1MobileAdapter {
  readonly capabilities: CapabilityRegistry<A1MobileCapability>;

  /** Verify and normalise an inbound webhook. Never trusts an unverified body. */
  verifyAndParse(delivery: RawWebhookDelivery, context: DeliveryContext): VerificationResult;

  answerCall(callId: string, context: CommandContext): Promise<CommandResult<CommandAck>>;
  speak(input: SpeakInput, context: CommandContext): Promise<CommandResult<CommandAck>>;
  gather(input: GatherInput, context: CommandContext): Promise<CommandResult<CommandAck>>;
  /** Places the client on hold while Iris asks the founder. */
  hold(callId: string, context: CommandContext): Promise<CommandResult<CommandAck>>;
  resume(callId: string, context: CommandContext): Promise<CommandResult<CommandAck>>;
  transferCall(input: TransferInput, context: CommandContext): Promise<CommandResult<CommandAck>>;
  terminateCall(
    callId: string,
    reason: CallEndReason,
    context: CommandContext,
  ): Promise<CommandResult<CommandAck>>;
  sendSms(input: SendSmsInput, context: CommandContext): Promise<CommandResult<SentSms>>;
}
