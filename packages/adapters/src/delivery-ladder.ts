/**
 * The founder-prompt fallback ladder.
 *
 * Hands-free delivery to the glasses is unproven on Android and unsupported as
 * designed on iOS (docs/meta-wearable-spike.md §1.3), so the ladder is not
 * defensive padding around a happy path — it *is* the design:
 *
 *     glasses → companion push → founder web inbox → honest client deferral
 *
 * Each rung must positively acknowledge before it counts as delivered. A rung
 * that fails is tried past, not retried forever, and if every rung refuses the
 * caller is told so plainly, which is what lets the orchestrator give the
 * client a truthful deferral instead of silence.
 */

import type {
  DeliveryOptions,
  DeliveryOutcome,
  FounderChannel,
  MetaWearableAdapter,
  UndeliverableReason,
  WearablePrompt,
} from './meta-wearable/contract.js';

export interface LadderAttempt {
  readonly channel: FounderChannel;
  readonly outcome: DeliveryOutcome;
}

export type LadderResult =
  | {
      readonly delivered: true;
      readonly channel: FounderChannel;
      readonly presentedAt: string;
      /** Every rung tried, in order, for the audit timeline. */
      readonly attempts: readonly LadderAttempt[];
    }
  | {
      readonly delivered: false;
      /** Why each rung refused, so the founder console can explain the gap. */
      readonly attempts: readonly LadderAttempt[];
      readonly reasons: readonly UndeliverableReason[];
    };

/**
 * Per-rung idempotency key.
 *
 * Each channel gets its own, so descending the ladder is never mistaken for a
 * retry of the rung above — otherwise an adapter that had already seen the
 * shared key would report a phantom duplicate and the prompt would silently
 * never be shown.
 */
export function rungIdempotencyKey(baseKey: string, channel: FounderChannel): string {
  return `${baseKey}#${channel}`;
}

/**
 * Walk the ladder until a rung acknowledges.
 *
 * Rungs are tried strictly in the order given — the caller decides the
 * preference order, because it depends on the founder's availability mode and
 * on which platform their phone is.
 */
export async function deliverViaLadder(
  rungs: readonly MetaWearableAdapter[],
  prompt: WearablePrompt,
  options: DeliveryOptions,
): Promise<LadderResult> {
  const attempts: LadderAttempt[] = [];

  for (const adapter of rungs) {
    const outcome = await adapter.deliverPrompt(prompt, {
      ...options,
      idempotencyKey: rungIdempotencyKey(options.idempotencyKey, adapter.channel),
    });

    attempts.push({ channel: adapter.channel, outcome });

    if (outcome.status === 'presented') {
      return {
        delivered: true,
        channel: outcome.channel,
        presentedAt: outcome.presentedAt,
        attempts,
      };
    }
  }

  return {
    delivered: false,
    attempts,
    reasons: attempts.flatMap((attempt) =>
      attempt.outcome.status === 'undeliverable' ? [attempt.outcome.reason] : [],
    ),
  };
}

/**
 * Withdraw a prompt from every rung.
 *
 * Called when the client hangs up or another rung already answered. Best effort
 * across all of them: a rung that errors must not stop the others being told,
 * or a founder ends up answering a question for a client who left.
 */
export async function cancelAcrossLadder(
  rungs: readonly MetaWearableAdapter[],
  escalationId: string,
  reason: string,
): Promise<void> {
  await Promise.allSettled(rungs.map((adapter) => adapter.cancelPrompt(escalationId, reason)));
}
