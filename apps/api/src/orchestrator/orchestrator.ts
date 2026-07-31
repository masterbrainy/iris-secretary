/**
 * The conversation orchestrator.
 *
 * CLAUDE.md requires **one** orchestrator with **one** deterministic state
 * machine — intake, retrieval, resolution, escalation, relay and knowledge
 * curation are modules inside it, not independent agents. This file is the
 * intake half: it takes a provider webhook and turns it into at most one state
 * transition, with an audit record for everything that happened, including the
 * things that deliberately did not.
 *
 * The order of operations is the whole point:
 *
 *   verify → envelope → deduplicate → map to a domain event → transition →
 *   audit → record the delivery
 *
 * Deduplication happens **before** any state change, and the delivery is
 * recorded **after** the work, so a crash in between replays rather than
 * silently losing the event. Recording it first would make a crash look like
 * success and drop the event on the floor.
 */

import {
  createEnvelope,
  decideIngest,
  transition,
  type ConversationEventType,
  type ConversationState,
  type InboundEventEnvelope,
} from '@cynthia/domain';
import type {
  A1MobileAdapter,
  A1MobilePayload,
  DeliveryContext,
  RawWebhookDelivery,
} from '@cynthia/adapters';
import { INITIAL_CONTEXT } from '@cynthia/domain';
import type { ConversationRecord, OrchestratorPorts } from './ports.js';

export type IngestOutcome =
  | {
      readonly kind: 'processed';
      readonly conversationId: string;
      readonly state: ConversationState;
      readonly outOfOrder: boolean;
    }
  | {
      readonly kind: 'skipped-duplicate';
      readonly idempotencyKey: string;
      readonly originalTraceId: string;
    }
  | {
      /** Real and accepted, but this event moves no state on its own. */
      readonly kind: 'observed';
      readonly conversationId: string | undefined;
      readonly detail: string;
    }
  | {
      /** The transition was illegal in the current state. State is unchanged. */
      readonly kind: 'transition-rejected';
      readonly conversationId: string;
      readonly state: ConversationState;
      readonly reason: string;
    }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Which conversation event, if any, a provider payload implies.
 *
 * Returning `undefined` is a real answer, not a gap: a transcript segment or a
 * delivery receipt is genuine information that changes no state by itself.
 * Those are audited as observations so the timeline still shows them.
 */
export function conversationEventFor(payload: A1MobilePayload): ConversationEventType | undefined {
  switch (payload.kind) {
    case 'call.answered':
      return 'CALL_ANSWERED';
    case 'call.ended':
      return 'CALLER_HUNG_UP';
    case 'call.incoming':
    case 'transcript.segment':
    case 'sms.inbound':
    case 'sms.status':
    case 'recording.ready':
      return undefined;
  }
}

export interface Orchestrator {
  handleInboundEvent(
    delivery: RawWebhookDelivery,
    context: DeliveryContext,
  ): Promise<IngestOutcome>;
}

export interface OrchestratorDeps {
  readonly telephony: A1MobileAdapter;
  readonly ports: OrchestratorPorts;
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { telephony, ports } = deps;

  async function conversationFor(
    payload: A1MobilePayload,
    envelope: InboundEventEnvelope,
  ): Promise<ConversationRecord | undefined> {
    if (payload.kind === 'call.incoming') {
      const existing = await ports.conversations.findByProviderCallId(payload.callId);
      if (existing !== undefined) return existing;

      const created: ConversationRecord = {
        conversationId: ports.ids.newConversationId(),
        providerCallId: payload.callId,
        state: 'RINGING',
        context: INITIAL_CONTEXT,
        callerNumber: payload.from,
        updatedAt: envelope.receivedAt,
      };
      await ports.conversations.save(created);
      return created;
    }

    if ('callId' in payload) {
      return ports.conversations.findByProviderCallId(payload.callId);
    }
    return undefined;
  }

  return {
    async handleInboundEvent(delivery, context) {
      const verified = telephony.verifyAndParse(delivery, context);
      if (!verified.ok) {
        await ports.audit.append({
          kind: 'ingest-rejected',
          traceId: context.traceId,
          reason: `${verified.failure.kind}: ${verified.failure.message}`,
          occurredAt: ports.clock.now(),
        });
        return { kind: 'rejected', reason: verified.failure.kind };
      }

      const built = createEnvelope(verified.event.envelope);
      if (!built.ok) {
        await ports.audit.append({
          kind: 'ingest-rejected',
          traceId: context.traceId,
          reason: `${built.reason}: ${built.message}`,
          occurredAt: ports.clock.now(),
        });
        return { kind: 'rejected', reason: built.reason };
      }

      const envelope = built.envelope;
      const payload = verified.event.payload;

      // Deduplicate before touching any state, so a redelivery cannot cause a
      // second transition, a second message, or a second follow-up.
      const prior = await ports.ledger.find(envelope.idempotencyKey);
      const conversation = await conversationFor(payload, envelope);
      const highWaterMark =
        conversation === undefined
          ? undefined
          : await ports.ledger.highWaterMark(conversation.conversationId);

      const decision = decideIngest(envelope, { priorDelivery: prior, highWaterMark });

      if (decision.kind === 'skip') {
        await ports.audit.append({
          kind: 'duplicate-skipped',
          traceId: envelope.traceId,
          idempotencyKey: decision.idempotencyKey,
          originalTraceId: decision.originalTraceId,
          occurredAt: ports.clock.now(),
        });
        return {
          kind: 'skipped-duplicate',
          idempotencyKey: decision.idempotencyKey,
          originalTraceId: decision.originalTraceId,
        };
      }

      const eventType = conversationEventFor(payload);

      if (conversation === undefined || eventType === undefined) {
        const detail =
          conversation === undefined
            ? `No conversation is associated with ${payload.kind}.`
            : `${payload.kind} carries information but moves no state.`;

        await ports.audit.append({
          kind: 'observed',
          conversationId: conversation?.conversationId,
          traceId: envelope.traceId,
          providerEventKind: payload.kind,
          occurredAt: ports.clock.now(),
          detail,
        });
        await recordDelivery(envelope, conversation?.conversationId);
        return { kind: 'observed', conversationId: conversation?.conversationId, detail };
      }

      const result = transition({
        state: conversation.state,
        context: conversation.context,
        event: eventType,
        conversationId: conversation.conversationId,
        traceId: envelope.traceId,
        occurredAt: ports.clock.now(),
      });

      if (!result.ok) {
        await ports.audit.append({
          kind: 'transition-rejected',
          conversationId: conversation.conversationId,
          traceId: envelope.traceId,
          state: conversation.state,
          attemptedEvent: eventType,
          rejection: result.rejection,
          occurredAt: ports.clock.now(),
        });
        // The delivery is still recorded: it was handled, and the answer was
        // "no". Leaving it unrecorded would let a retry re-attempt it forever.
        await recordDelivery(envelope, conversation.conversationId);
        return {
          kind: 'transition-rejected',
          conversationId: conversation.conversationId,
          state: conversation.state,
          reason: result.rejection.message,
        };
      }

      await ports.conversations.save({
        ...conversation,
        state: result.state,
        context: result.context,
        updatedAt: ports.clock.now(),
      });
      await ports.audit.append({ kind: 'transition', event: result.audit });
      await recordDelivery(envelope, conversation.conversationId);

      return {
        kind: 'processed',
        conversationId: conversation.conversationId,
        state: result.state,
        outOfOrder: decision.outOfOrder,
      };
    },
  };

  async function recordDelivery(
    envelope: InboundEventEnvelope,
    conversationId: string | undefined,
  ): Promise<void> {
    await ports.ledger.record({
      idempotencyKey: envelope.idempotencyKey,
      traceId: envelope.traceId,
      receivedAt: envelope.receivedAt,
      conversationId,
    });
    if (conversationId !== undefined && envelope.sequence !== undefined) {
      await ports.ledger.setHighWaterMark(conversationId, envelope.sequence);
    }
  }
}
