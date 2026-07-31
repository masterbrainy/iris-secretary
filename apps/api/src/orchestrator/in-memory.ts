/**
 * In-memory implementations of the orchestrator's ports.
 *
 * These are the real implementations for local development and tests, not
 * stubs: the orchestrator's behaviour against them is the behaviour it will
 * have against Supabase, because the port is the whole contract. The
 * Supabase-backed versions land with roadmap phase 3.
 *
 * Deterministic throughout — the clock only moves when a test advances it, and
 * ids come from a counter.
 */

import type { DeliveryRecord } from '@iris/domain';
import type {
  AuditRecord,
  AuditSink,
  Clock,
  ConversationRecord,
  ConversationStore,
  DeliveryLedger,
  IdGenerator,
  OrchestratorPorts,
} from './ports.js';

export interface TestClock extends Clock {
  advance(ms: number): void;
}

export function createTestClock(startAt = '2026-07-31T10:00:00.000Z'): TestClock {
  let currentMs = new Date(startAt).getTime();
  return {
    now: () => new Date(currentMs).toISOString(),
    advance(ms: number) {
      currentMs += ms;
    },
  };
}

export function createCountingIdGenerator(prefix = 'conv'): IdGenerator {
  let count = 0;
  return {
    newConversationId() {
      count += 1;
      return `${prefix}-${String(count)}`;
    },
  };
}

export interface InMemoryConversationStore extends ConversationStore {
  all(): readonly ConversationRecord[];
}

export function createInMemoryConversationStore(): InMemoryConversationStore {
  const byId = new Map<string, ConversationRecord>();
  const byProviderCallId = new Map<string, string>();

  return {
    find(conversationId) {
      return Promise.resolve(byId.get(conversationId));
    },
    findByProviderCallId(providerCallId) {
      const id = byProviderCallId.get(providerCallId);
      return Promise.resolve(id === undefined ? undefined : byId.get(id));
    },
    save(record) {
      byId.set(record.conversationId, record);
      if (record.providerCallId !== undefined) {
        byProviderCallId.set(record.providerCallId, record.conversationId);
      }
      return Promise.resolve();
    },
    all() {
      return [...byId.values()];
    },
  };
}

export interface InMemoryAuditSink extends AuditSink {
  readonly records: readonly AuditRecord[];
  ofKind<K extends AuditRecord['kind']>(kind: K): Extract<AuditRecord, { kind: K }>[];
}

export function createInMemoryAuditSink(): InMemoryAuditSink {
  const records: AuditRecord[] = [];
  return {
    append(record) {
      records.push(record);
      return Promise.resolve();
    },
    get records() {
      return records;
    },
    ofKind<K extends AuditRecord['kind']>(kind: K) {
      return records.filter((r): r is Extract<AuditRecord, { kind: K }> => r.kind === kind);
    },
  };
}

export function createInMemoryDeliveryLedger(): DeliveryLedger {
  const byKey = new Map<string, DeliveryRecord>();
  const marks = new Map<string, number>();

  return {
    find(idempotencyKey) {
      return Promise.resolve(byKey.get(idempotencyKey));
    },
    record(entry) {
      byKey.set(entry.idempotencyKey, {
        idempotencyKey: entry.idempotencyKey,
        traceId: entry.traceId,
        receivedAt: entry.receivedAt,
      });
      return Promise.resolve();
    },
    highWaterMark(conversationId) {
      return Promise.resolve(marks.get(conversationId));
    },
    setHighWaterMark(conversationId, sequence) {
      const current = marks.get(conversationId);
      // Never move the mark backwards — a late event must not rewrite history.
      if (current === undefined || sequence > current) marks.set(conversationId, sequence);
      return Promise.resolve();
    },
  };
}

export interface InMemoryPorts extends OrchestratorPorts {
  readonly conversations: InMemoryConversationStore;
  readonly audit: InMemoryAuditSink;
  readonly clock: TestClock;
}

export function createInMemoryPorts(startAt?: string): InMemoryPorts {
  return {
    conversations: createInMemoryConversationStore(),
    audit: createInMemoryAuditSink(),
    ledger: createInMemoryDeliveryLedger(),
    clock: createTestClock(startAt),
    ids: createCountingIdGenerator(),
  };
}
