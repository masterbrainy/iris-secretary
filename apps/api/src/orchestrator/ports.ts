/**
 * Ports the orchestrator depends on.
 *
 * Everything impure lives behind one of these: persistence, the clock, and id
 * generation. That keeps the orchestrator itself a deterministic function of
 * its inputs, which is what makes the escalation flow reproducible in tests —
 * and it means the Supabase-backed implementations can land later without the
 * orchestrator changing.
 */

import type {
  ConversationContext,
  ConversationEventType,
  ConversationState,
  DeliveryRecord,
  TransitionAuditEvent,
  TransitionRejection,
} from '@iris/domain';

export interface ConversationRecord {
  readonly conversationId: string;
  /** The provider's call id, so later events find their way back here. */
  readonly providerCallId: string | undefined;
  readonly state: ConversationState;
  readonly context: ConversationContext;
  readonly callerNumber: string | undefined;
  readonly updatedAt: string;
}

export interface ConversationStore {
  find(conversationId: string): Promise<ConversationRecord | undefined>;
  findByProviderCallId(providerCallId: string): Promise<ConversationRecord | undefined>;
  save(record: ConversationRecord): Promise<void>;
}

/**
 * The audit trail.
 *
 * It records more than accepted transitions: a rejected transition and a
 * skipped duplicate are both things somebody will need to explain later, and
 * an audit that only shows what succeeded cannot answer "why did nothing
 * happen when the provider clearly sent us something?"
 */
export type AuditRecord =
  | { readonly kind: 'transition'; readonly event: TransitionAuditEvent }
  | {
      readonly kind: 'transition-rejected';
      readonly conversationId: string;
      readonly traceId: string;
      readonly state: ConversationState;
      readonly attemptedEvent: ConversationEventType;
      readonly rejection: TransitionRejection;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'duplicate-skipped';
      readonly traceId: string;
      readonly idempotencyKey: string;
      readonly originalTraceId: string;
      readonly occurredAt: string;
    }
  | {
      /** A provider event that is real and accepted but changes no state. */
      readonly kind: 'observed';
      readonly conversationId: string | undefined;
      readonly traceId: string;
      readonly providerEventKind: string;
      readonly occurredAt: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'ingest-rejected';
      readonly traceId: string;
      readonly reason: string;
      readonly occurredAt: string;
    };

export interface AuditSink {
  append(record: AuditRecord): Promise<void>;
}

/**
 * Remembers which provider events have already been handled, and how far along
 * each conversation's provider sequence we have got.
 */
export interface DeliveryLedger {
  find(idempotencyKey: string): Promise<DeliveryRecord | undefined>;
  record(entry: DeliveryRecord & { readonly conversationId: string | undefined }): Promise<void>;
  highWaterMark(conversationId: string): Promise<number | undefined>;
  setHighWaterMark(conversationId: string, sequence: number): Promise<void>;
}

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  newConversationId(): string;
}

export interface OrchestratorPorts {
  readonly conversations: ConversationStore;
  readonly audit: AuditSink;
  readonly ledger: DeliveryLedger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
