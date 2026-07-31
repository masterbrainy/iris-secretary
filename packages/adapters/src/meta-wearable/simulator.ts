/**
 * MetaWearableSimulator — a deterministic stand-in for the founder-prompting
 * channel.
 *
 * It implements the same contract as the (currently refusing) production
 * adapter, so the escalation flow exercised in tests is the flow that will run
 * once a companion app exists. It models the parts of the real world that
 * matter to the orchestrator: a prompt is only delivered when acknowledged, a
 * founder response is only produced by an explicit action, and a device can be
 * offline or a platform can refuse to wake the app.
 *
 * Deterministic: the clock only moves when a test advances it, and there is no
 * randomness anywhere.
 */

import {
  META_WEARABLE_CAPABILITIES,
  type AdapterHealth,
  type DeliveryOptions,
  type DeliveryOutcome,
  type FounderChannel,
  type FounderResponseEvent,
  type MetaWearableAdapter,
  type UndeliverableReason,
  type Unsubscribe,
  type WearablePrompt,
} from './contract.js';

export interface DeliveredPrompt {
  readonly prompt: WearablePrompt;
  readonly deliveredAt: string;
  readonly idempotencyKey: string;
}

/** Why a founder response the simulator was asked to produce was rejected. */
export type ResponseRejection = 'unknown-escalation' | 'already-resolved' | 'cancelled';

export type ResponseResult =
  { readonly accepted: true } | { readonly accepted: false; readonly rejection: ResponseRejection };

export interface MetaWearableSimulatorOptions {
  readonly startAt?: string;
  readonly channel?: FounderChannel;
}

export interface MetaWearableSimulator extends MetaWearableAdapter {
  now(): string;
  advance(ms: number): void;

  /** Glasses disconnected / hinges closed. Prompts become undeliverable. */
  setOffline(offline: boolean): void;
  /**
   * Force a specific delivery failure — used to reproduce the documented iOS
   * background-audio refusal, a denied permission, or do-not-disturb.
   */
  setDeliveryFailure(reason: UndeliverableReason | undefined): void;

  /** Prompts delivered and still awaiting a founder action. */
  outstanding(): readonly WearablePrompt[];
  readonly delivered: readonly DeliveredPrompt[];

  // --- founder actions -----------------------------------------------------
  founderAnswers(
    escalationId: string,
    text: string,
    options?: { readonly transcriptionConfidence?: number; readonly audioRef?: string },
  ): ResponseResult;
  founderDeclines(escalationId: string): ResponseResult;
  founderDefers(escalationId: string): ResponseResult;
  /** The explicit affirmative action — the only route to a handoff. */
  founderTakesCall(escalationId: string): ResponseResult;
}

export function createMetaWearableSimulator(
  options: MetaWearableSimulatorOptions = {},
): MetaWearableSimulator {
  const channel: FounderChannel = options.channel ?? 'simulator';
  let currentMs = new Date(options.startAt ?? '2026-07-31T10:00:00.000Z').getTime();

  let offline = false;
  let forcedFailure: UndeliverableReason | undefined;

  const handlers = new Set<(event: FounderResponseEvent) => void>();
  const deliveredPrompts: DeliveredPrompt[] = [];
  /** Escalations awaiting an action. Removed once resolved or cancelled. */
  const pending = new Map<string, WearablePrompt>();
  /** Escalations that already produced a response, or were withdrawn. */
  const closed = new Map<string, ResponseRejection>();
  const deliveriesByKey = new Map<string, DeliveryOutcome>();

  function now(): string {
    return new Date(currentMs).toISOString();
  }

  function emit(event: FounderResponseEvent): void {
    for (const handler of handlers) handler(event);
  }

  /**
   * A response is only accepted for an escalation that is still outstanding.
   * A late reply to something already answered, or to a prompt that was
   * withdrawn because the client hung up, is dropped — applying it would land
   * an answer on a conversation that has moved on.
   */
  function resolve(escalationId: string): ResponseResult {
    if (!pending.has(escalationId)) {
      return { accepted: false, rejection: closed.get(escalationId) ?? 'unknown-escalation' };
    }
    pending.delete(escalationId);
    closed.set(escalationId, 'already-resolved');
    return { accepted: true };
  }

  return {
    channel,
    capabilities: META_WEARABLE_CAPABILITIES,

    now,
    advance(ms: number) {
      currentMs += ms;
    },
    setOffline(value: boolean) {
      offline = value;
    },
    setDeliveryFailure(reason: UndeliverableReason | undefined) {
      forcedFailure = reason;
    },
    outstanding() {
      return [...pending.values()];
    },
    get delivered() {
      return deliveredPrompts;
    },

    deliverPrompt(prompt: WearablePrompt, deliveryOptions: DeliveryOptions) {
      const existing = deliveriesByKey.get(deliveryOptions.idempotencyKey);
      if (existing !== undefined) {
        return Promise.resolve(
          existing.status === 'presented' ? { ...existing, deduplicated: true } : existing,
        );
      }

      const failure: UndeliverableReason | undefined =
        forcedFailure ?? (offline ? 'device-unavailable' : undefined);

      if (failure !== undefined) {
        const outcome: DeliveryOutcome = {
          status: 'undeliverable',
          channel,
          reason: failure,
          detail: `Simulated delivery failure: ${failure}.`,
        };
        // Deliberately not memoised: a failed delivery should be retryable, and
        // the orchestrator's ladder depends on being able to try again.
        return Promise.resolve(outcome);
      }

      const outcome: DeliveryOutcome = {
        status: 'presented',
        channel,
        presentedAt: now(),
        deduplicated: false,
      };
      deliveriesByKey.set(deliveryOptions.idempotencyKey, outcome);
      deliveredPrompts.push({
        prompt,
        deliveredAt: now(),
        idempotencyKey: deliveryOptions.idempotencyKey,
      });
      pending.set(prompt.escalationId, prompt);
      return Promise.resolve(outcome);
    },

    cancelPrompt(escalationId: string, _reason: string) {
      pending.delete(escalationId);
      closed.set(escalationId, 'cancelled');
      return Promise.resolve();
    },

    onFounderResponse(handler: (event: FounderResponseEvent) => void): Unsubscribe {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    health(): Promise<AdapterHealth> {
      return Promise.resolve(
        offline
          ? { reachable: false, detail: 'Simulated device is offline.' }
          : { reachable: true, detail: 'Simulator is reachable.' },
      );
    },

    founderAnswers(escalationId, text, answerOptions) {
      const result = resolve(escalationId);
      if (!result.accepted) return result;

      emit({
        kind: 'answered',
        escalationId,
        channel,
        receivedAt: now(),
        text,
        transcriptionConfidence: answerOptions?.transcriptionConfidence ?? 0.92,
        audioRef: answerOptions?.audioRef,
      });
      return result;
    },

    founderDeclines(escalationId) {
      const result = resolve(escalationId);
      if (result.accepted) {
        emit({ kind: 'declined', escalationId, channel, receivedAt: now() });
      }
      return result;
    },

    founderDefers(escalationId) {
      const result = resolve(escalationId);
      if (result.accepted) {
        emit({ kind: 'deferred', escalationId, channel, receivedAt: now() });
      }
      return result;
    },

    founderTakesCall(escalationId) {
      const result = resolve(escalationId);
      if (result.accepted) {
        emit({ kind: 'took-call', escalationId, channel, receivedAt: now() });
      }
      return result;
    },
  };
}
