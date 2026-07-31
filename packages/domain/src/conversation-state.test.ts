import { describe, expect, it } from 'vitest';
import {
  ALL_EVENTS,
  ALL_STATES,
  INITIAL_CONTEXT,
  TERMINAL_STATE,
  allowedEvents,
  isTerminal,
  transition,
  type ConversationContext,
  type ConversationEventType,
  type ConversationState,
  type TransitionAuditEvent,
} from './conversation-state.js';

const AT = '2026-07-31T10:00:00.000Z';

/** Drive a sequence of events, asserting each one is accepted. */
function run(
  from: ConversationState,
  events: ConversationEventType[],
  context: ConversationContext = INITIAL_CONTEXT,
): { state: ConversationState; context: ConversationContext; audits: TransitionAuditEvent[] } {
  let state = from;
  let ctx = context;
  const audits: TransitionAuditEvent[] = [];

  for (const event of events) {
    const result = transition({
      state,
      context: ctx,
      event,
      conversationId: 'conv-1',
      traceId: 'trace-1',
      occurredAt: AT,
    });
    if (!result.ok) {
      throw new Error(`expected ${event} to be accepted in ${state}: ${result.rejection.message}`);
    }
    state = result.state;
    ctx = result.context;
    audits.push(result.audit);
  }

  return { state, context: ctx, audits };
}

/** Attempt a single event without asserting success. */
function attempt(
  state: ConversationState,
  event: ConversationEventType,
  context: ConversationContext = INITIAL_CONTEXT,
) {
  return transition({
    state,
    context,
    event,
    conversationId: 'conv-1',
    traceId: 'trace-1',
    occurredAt: AT,
  });
}

describe('the thirteen states', () => {
  it('covers exactly the states CLAUDE.md specifies', () => {
    expect([...ALL_STATES].sort()).toEqual(
      [
        'ACTIVE',
        'CLARIFYING',
        'DEFERRED',
        'ENDED',
        'ESCALATION_PENDING',
        'FAILED',
        'FOUNDER_PROMPTED',
        'FOUNDER_RESPONDED',
        'HANDOFF',
        'RELAYING',
        'RESOLVED',
        'RESOLVING',
        'RINGING',
      ].sort(),
    );
    expect(ALL_STATES).toHaveLength(13);
  });
});

describe('the flows the PRD demo has to show', () => {
  it('answers a routine question directly from approved knowledge', () => {
    const { state } = run('RINGING', [
      'CALL_ANSWERED',
      'RESOLUTION_STARTED',
      'ANSWER_DELIVERED',
      'CONVERSATION_ENDED',
    ]);
    expect(state).toBe('ENDED');
  });

  it('escalates, takes a founder answer, and relays it to the client', () => {
    const { state, audits } = run('RINGING', [
      'CALL_ANSWERED',
      'RESOLUTION_STARTED',
      'ESCALATION_REQUIRED',
      'FOUNDER_PROMPT_DELIVERED',
      'FOUNDER_ANSWERED',
      'RELAY_STARTED',
      'RELAY_COMPLETED',
      'CONVERSATION_ENDED',
    ]);
    expect(state).toBe('ENDED');
    expect(audits.map((a) => a.to)).toEqual([
      'ACTIVE',
      'RESOLVING',
      'ESCALATION_PENDING',
      'FOUNDER_PROMPTED',
      'FOUNDER_RESPONDED',
      'RELAYING',
      'RESOLVED',
      'ENDED',
    ]);
  });

  it('asks one clarification, then resolves', () => {
    const { state, context } = run('RINGING', [
      'CALL_ANSWERED',
      'CLARIFICATION_ASKED',
      'CLARIFICATION_RECEIVED',
      'ANSWER_DELIVERED',
    ]);
    expect(state).toBe('RESOLVED');
    expect(context.clarificationCount).toBe(1);
  });
});

describe('founder-unavailable handling', () => {
  it('defers rather than fabricating an answer when the founder does not respond', () => {
    const { state } = run('RINGING', [
      'CALL_ANSWERED',
      'ESCALATION_REQUIRED',
      'FOUNDER_PROMPT_DELIVERED',
      'FOUNDER_UNAVAILABLE',
    ]);
    expect(state).toBe('DEFERRED');
  });

  it('defers when the prompt could not be delivered on any fallback rung', () => {
    const { state } = run('RINGING', [
      'CALL_ANSWERED',
      'ESCALATION_REQUIRED',
      'FOUNDER_UNAVAILABLE',
    ]);
    expect(state).toBe('DEFERRED');
  });

  it('has no path from a founder timeout to a delivered answer', () => {
    const { state } = run('RINGING', [
      'CALL_ANSWERED',
      'ESCALATION_REQUIRED',
      'FOUNDER_PROMPT_DELIVERED',
      'FOUNDER_UNAVAILABLE',
    ]);
    expect(attempt(state, 'RELAY_STARTED').ok).toBe(false);
    expect(attempt(state, 'ANSWER_DELIVERED').ok).toBe(false);
  });
});

describe('CLAUDE.md invariants, enforced structurally', () => {
  it('permits at most one clarification question', () => {
    const { state, context } = run('RINGING', ['CALL_ANSWERED', 'CLARIFICATION_ASKED']);
    expect(state).toBe('CLARIFYING');

    // Even back in a state where the table allows it, the count forbids it.
    const back = run('CLARIFYING', ['CLARIFICATION_RECEIVED'], context);
    const second = attempt('ACTIVE', 'CLARIFICATION_ASKED', back.context);

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.rejection.reason).toBe('clarification-limit');
    }
  });

  it('only ever enters HANDOFF through explicit founder acceptance', () => {
    const routes = ALL_STATES.flatMap((state) =>
      ALL_EVENTS.map((event) => ({ state, event, result: attempt(state, event) })),
    ).filter((r) => r.result.ok && r.result.state === 'HANDOFF');

    expect(routes).toHaveLength(1);
    expect(routes[0]!.event).toBe('FOUNDER_ACCEPTED_HANDOFF');
    expect(routes[0]!.state).toBe('FOUNDER_PROMPTED');
  });

  it('only ever enters CLARIFYING from ACTIVE, so a clarification cannot recur mid-flow', () => {
    const entries = ALL_STATES.flatMap((state) =>
      ALL_EVENTS.map((event) => ({ state, event, result: attempt(state, event) })),
    ).filter((r) => r.result.ok && r.result.state === 'CLARIFYING');

    expect(entries.map((e) => e.state)).toEqual(['ACTIVE']);
  });

  it('cannot reach DEFERRED without first attempting escalation or hitting a failure', () => {
    const entries = ALL_STATES.flatMap((state) =>
      ALL_EVENTS.map((event) => ({ state, event, result: attempt(state, event) })),
    ).filter((r) => r.result.ok && r.result.state === 'DEFERRED');

    expect([...new Set(entries.map((e) => e.state))].sort()).toEqual([
      'ESCALATION_PENDING',
      'FAILED',
      'FOUNDER_PROMPTED',
      'FOUNDER_RESPONDED',
      'HANDOFF',
    ]);
  });

  it('routes every dependency failure to FAILED from every live state', () => {
    const live = ALL_STATES.filter(
      (s) => !isTerminal(s) && !['RESOLVED', 'DEFERRED', 'FAILED'].includes(s),
    );
    for (const state of live) {
      const result = attempt(state, 'DEPENDENCY_FAILED');
      expect(result.ok, `${state} should accept DEPENDENCY_FAILED`).toBe(true);
      if (result.ok) expect(result.state).toBe('FAILED');
    }
  });

  it('lets a failure recover into a safe deferral with the client informed', () => {
    const { state } = run('FAILED', ['RECOVERED_TO_SAFE_STATE']);
    expect(state).toBe('DEFERRED');
  });
});

describe('graph properties', () => {
  /** Breadth-first walk over accepted transitions, ignoring context guards. */
  function reachableFrom(start: ConversationState): Set<ConversationState> {
    const seen = new Set<ConversationState>([start]);
    const queue: ConversationState[] = [start];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const event of ALL_EVENTS) {
        const result = attempt(current, event);
        if (result.ok && !seen.has(result.state)) {
          seen.add(result.state);
          queue.push(result.state);
        }
      }
    }
    return seen;
  }

  it('reaches every state from RINGING, so no state is orphaned by a table typo', () => {
    const reachable = reachableFrom('RINGING');
    expect([...reachable].sort()).toEqual([...ALL_STATES].sort());
  });

  it('can always reach ENDED, so a client is never stranded mid-conversation', () => {
    for (const state of ALL_STATES) {
      expect(reachableFrom(state).has(TERMINAL_STATE), `${state} cannot reach ENDED`).toBe(true);
    }
  });

  it('never transitions to a state outside the declared set', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const result = attempt(state, event);
        if (result.ok) expect(ALL_STATES).toContain(result.state);
      }
    }
  });
});

describe('rejection', () => {
  it('refuses every event once the conversation has ended', () => {
    for (const event of ALL_EVENTS) {
      const result = attempt(TERMINAL_STATE, event);
      expect(result.ok, `ENDED should refuse ${event}`).toBe(false);
      if (!result.ok) expect(result.rejection.reason).toBe('terminal-state');
    }
  });

  it('refuses events that make no sense in the current state', () => {
    const cases: [ConversationState, ConversationEventType][] = [
      ['RINGING', 'FOUNDER_ANSWERED'],
      ['ACTIVE', 'RELAY_COMPLETED'],
      ['RESOLVING', 'FOUNDER_ACCEPTED_HANDOFF'],
      ['ESCALATION_PENDING', 'FOUNDER_ANSWERED'],
      ['RELAYING', 'ESCALATION_REQUIRED'],
      ['RESOLVED', 'ANSWER_DELIVERED'],
      ['DEFERRED', 'RELAY_STARTED'],
    ];

    for (const [state, event] of cases) {
      const result = attempt(state, event);
      expect(result.ok, `${state} should refuse ${event}`).toBe(false);
      if (!result.ok) {
        expect(result.rejection.reason).toBe('not-allowed');
        expect(result.rejection.message).toContain(event);
      }
    }
  });

  it('leaves state and context untouched when it rejects', () => {
    const context: ConversationContext = { clarificationCount: 1 };
    const result = attempt('RESOLVING', 'FOUNDER_ANSWERED', context);

    expect(result.ok).toBe(false);
    expect(result.state).toBe('RESOLVING');
    expect(result.context).toEqual(context);
  });
});

describe('audit events', () => {
  it('emits one per accepted transition, carrying the full trail', () => {
    const { audits } = run('RINGING', ['CALL_ANSWERED', 'RESOLUTION_STARTED']);

    expect(audits).toHaveLength(2);
    expect(audits[0]).toEqual({
      conversationId: 'conv-1',
      traceId: 'trace-1',
      from: 'RINGING',
      to: 'ACTIVE',
      event: 'CALL_ANSWERED',
      occurredAt: AT,
    });
  });

  it('emits no audit event for a rejected transition', () => {
    const result = attempt('RINGING', 'RELAY_COMPLETED');
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('audit');
  });
});

describe('purity', () => {
  it('does not mutate the context it was given', () => {
    const context: ConversationContext = { clarificationCount: 0 };
    const result = attempt('ACTIVE', 'CLARIFICATION_ASKED', context);

    expect(context.clarificationCount).toBe(0);
    if (result.ok) expect(result.context.clarificationCount).toBe(1);
  });

  it('returns the same result for the same input every time', () => {
    const once = attempt('ACTIVE', 'ESCALATION_REQUIRED');
    const twice = attempt('ACTIVE', 'ESCALATION_REQUIRED');
    expect(once).toEqual(twice);
  });
});

describe('allowedEvents', () => {
  it('reports what the founder console may offer in a given state', () => {
    expect([...allowedEvents('FOUNDER_PROMPTED')].sort()).toEqual([
      'CALLER_HUNG_UP',
      'DEPENDENCY_FAILED',
      'FOUNDER_ACCEPTED_HANDOFF',
      'FOUNDER_ANSWERED',
      'FOUNDER_UNAVAILABLE',
    ]);
    expect(allowedEvents('ENDED')).toEqual([]);
  });
});
