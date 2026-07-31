/**
 * The Meta wearable adapter contract — how Cynthia asks the founder a question.
 *
 * The server-side contract **terminates at the companion app**, not at the
 * glasses. The Device Access Toolkit is a mobile SDK with no server API and no
 * cloud-to-glasses push (docs/meta-wearable-spike.md §1.1, §3.4), so every
 * prompt travels: server → push → companion app → Bluetooth → glasses.
 *
 * It is deliberately device-agnostic. The same events arise whether the founder
 * answered through glasses, the companion app, the web inbox, or the simulator,
 * which is exactly what makes the simulator honest rather than a fake.
 */

import type { CapabilityRegistry } from '../capability.js';

/**
 * Honest capability matrix, straight out of the spike.
 *
 * The two `unsupported` entries are not placeholders — Meta documents that
 * neither exists, so no amount of credentials would flip them. They are listed
 * so the founder console can say so rather than leaving a silent gap.
 */
export const META_WEARABLE_CAPABILITIES = {
  /** A2DP playback of the spoken prompt. Unverified without hardware. */
  'prompt.playAudio': 'pending',
  /** HFP capture of the founder's reply, 8 kHz mono. Unverified. */
  'response.captureVoice': 'pending',
  /** Waking a backgrounded app to prompt hands-free. Android plausible, iOS not. */
  'delivery.handsFreeBackground': 'pending',
  'device.sessionState': 'pending',
  /** Meta publishes no server-side API at all. Not a credentials problem. */
  'delivery.serverToGlassesPush': 'unsupported',
  /** "Hey Cynthia" is not offered by the toolkit and cannot be built. */
  'interaction.customWakeWord': 'unsupported',
} as const satisfies CapabilityRegistry;

export type MetaWearableCapability = keyof typeof META_WEARABLE_CAPABILITIES;

/**
 * Which rung of the fallback ladder a prompt reached, recorded on every event
 * so the audit timeline can show how the founder was actually reached.
 */
export type FounderChannel = 'glasses' | 'companion-app' | 'web-inbox' | 'simulator';

export type FounderAction = 'answer' | 'decline' | 'defer' | 'take-call';

export interface WearablePrompt {
  readonly escalationId: string;
  readonly conversationId: string;
  readonly traceId: string;
  /** Read aloud. Short — this is spoken into someone's ear mid-day. */
  readonly spokenText: string;
  /** The same content for channels that render rather than speak. */
  readonly displayText: string;
  readonly allowedActions: readonly FounderAction[];
  /** Authoritative copy lives with the orchestrator; this is a courtesy copy. */
  readonly expiresAt: string;
}

export type UndeliverableReason =
  /** Glasses disconnected, or the hinges were closed. */
  | 'device-unavailable'
  /** Could not establish a Device Access Toolkit session. */
  | 'session-unavailable'
  | 'permission-denied'
  | 'companion-app-unreachable'
  /** The documented iOS case: background audio cannot be started (spike §1.3). */
  | 'platform-denied-background-audio'
  /** Availability mode says do not disturb. */
  | 'founder-unavailable'
  | 'capability-pending';

/**
 * A prompt only counts as delivered when the far end positively acknowledges
 * it. Anything else is `undeliverable`, and the orchestrator degrades to the
 * next rung of the ladder. Silence is never treated as delivery.
 */
export type DeliveryOutcome =
  | {
      readonly status: 'presented';
      readonly channel: FounderChannel;
      readonly presentedAt: string;
      /** True when this idempotency key had already been delivered. */
      readonly deduplicated: boolean;
    }
  | {
      readonly status: 'undeliverable';
      readonly channel: FounderChannel;
      readonly reason: UndeliverableReason;
      readonly detail: string;
    };

/**
 * What the founder did.
 *
 * There is deliberately **no `expired` variant**. Expiry is the orchestrator's
 * timer firing, not something a device reports, and a dead or backgrounded
 * adapter must not be able to stall an escalation past its deadline. Leaving it
 * out of this union makes that structural rather than a rule someone remembers.
 */
export type FounderResponseEvent =
  | {
      readonly kind: 'answered';
      readonly escalationId: string;
      readonly channel: FounderChannel;
      readonly receivedAt: string;
      readonly text: string;
      /**
       * 0..1, mandatory. HFP capture is 8 kHz narrowband, so a low value has to
       * reach the policy gate that confirms critical details rather than being
       * quietly dropped on the floor.
       */
      readonly transcriptionConfidence: number;
      readonly audioRef: string | undefined;
    }
  | {
      readonly kind: 'declined';
      readonly escalationId: string;
      readonly channel: FounderChannel;
      readonly receivedAt: string;
    }
  | {
      readonly kind: 'deferred';
      readonly escalationId: string;
      readonly channel: FounderChannel;
      readonly receivedAt: string;
    }
  | {
      /**
       * Direct handoff. Only ever produced by an explicit affirmative action —
       * never inferred from the wording of an answer, and never from silence.
       */
      readonly kind: 'took-call';
      readonly escalationId: string;
      readonly channel: FounderChannel;
      readonly receivedAt: string;
    };

export interface DeliveryOptions {
  /** A retry with the same key must not prompt the founder twice. */
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
}

export type Unsubscribe = () => void;

export interface AdapterHealth {
  readonly reachable: boolean;
  readonly detail: string;
}

export interface MetaWearableAdapter {
  readonly channel: FounderChannel;
  readonly capabilities: CapabilityRegistry<MetaWearableCapability>;

  deliverPrompt(prompt: WearablePrompt, options: DeliveryOptions): Promise<DeliveryOutcome>;

  /**
   * Withdraw a prompt — the client hung up, or another rung already answered.
   * Best effort, but after it returns, a late response for that escalation must
   * be dropped rather than applied to a conversation that has moved on.
   */
  cancelPrompt(escalationId: string, reason: string): Promise<void>;

  onFounderResponse(handler: (event: FounderResponseEvent) => void): Unsubscribe;

  health(): Promise<AdapterHealth>;
}
