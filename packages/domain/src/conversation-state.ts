/**
 * The conversation state machine.
 *
 * This is the deterministic core CLAUDE.md requires: one state machine, every
 * transition explicit, invalid transitions rejected rather than tolerated, and
 * an audit event emitted for every accepted transition.
 *
 * It is pure by construction — no clock, no I/O, no randomness. Time and
 * identifiers are injected by the caller, which is what makes the whole
 * escalation flow reproducible in tests.
 */

export type ConversationState =
  | 'RINGING'
  | 'ACTIVE'
  | 'CLARIFYING'
  | 'RESOLVING'
  | 'ESCALATION_PENDING'
  | 'FOUNDER_PROMPTED'
  | 'FOUNDER_RESPONDED'
  | 'RELAYING'
  | 'RESOLVED'
  | 'DEFERRED'
  | 'HANDOFF'
  | 'FAILED'
  | 'ENDED';

export type ConversationEventType =
  /** The provider reports the inbound call was answered. */
  | 'CALL_ANSWERED'
  /** Iris asks its single permitted clarification question. */
  | 'CLARIFICATION_ASKED'
  /** The caller answered the clarification. */
  | 'CLARIFICATION_RECEIVED'
  /** Enough is known to attempt an answer from approved knowledge. */
  | 'RESOLUTION_STARTED'
  /** An approved, in-scope, confident answer was given directly. */
  | 'ANSWER_DELIVERED'
  /** Iris cannot safely answer and must ask the founder. */
  | 'ESCALATION_REQUIRED'
  /** A prompt reached the founder and was positively acknowledged. */
  | 'FOUNDER_PROMPT_DELIVERED'
  /** The founder gave a verbal answer. */
  | 'FOUNDER_ANSWERED'
  /** The founder explicitly accepted taking the call. Never inferred. */
  | 'FOUNDER_ACCEPTED_HANDOFF'
  /** Timeout, decline, defer, or undeliverable on every fallback rung. */
  | 'FOUNDER_UNAVAILABLE'
  /** The founder's answer passed policy check and is being spoken. */
  | 'RELAY_STARTED'
  /** The founder's answer failed policy check and must not be relayed. */
  | 'RELAY_REJECTED_BY_POLICY'
  /** The caller heard the relayed answer. */
  | 'RELAY_COMPLETED'
  /** The transfer to the founder completed. */
  | 'HANDOFF_COMPLETED'
  /** The transfer failed; Iris takes the client back. */
  | 'HANDOFF_FAILED'
  /** The caller hung up. */
  | 'CALLER_HUNG_UP'
  /** a1mobile, the AI service, Supabase, or the glasses integration failed. */
  | 'DEPENDENCY_FAILED'
  /** Recovery from failure into a safe state with callback info captured. */
  | 'RECOVERED_TO_SAFE_STATE'
  /** The conversation is over. */
  | 'CONVERSATION_ENDED';

/**
 * The transition table, written out in full rather than derived.
 *
 * This is the most consequential artifact in the codebase: it is what stops a
 * client being left in silence, stops a handoff happening without the founder
 * saying yes, and stops a second clarification question. Being able to read it
 * top to bottom is worth more than being able to generate it.
 */
const TRANSITIONS: Record<
  ConversationState,
  Partial<Record<ConversationEventType, ConversationState>>
> = {
  RINGING: {
    CALL_ANSWERED: 'ACTIVE',
    CALLER_HUNG_UP: 'ENDED',
    DEPENDENCY_FAILED: 'FAILED',
  },
  ACTIVE: {
    CLARIFICATION_ASKED: 'CLARIFYING',
    RESOLUTION_STARTED: 'RESOLVING',
    ESCALATION_REQUIRED: 'ESCALATION_PENDING',
    CALLER_HUNG_UP: 'ENDED',
    DEPENDENCY_FAILED: 'FAILED',
  },
  CLARIFYING: {
    CLARIFICATION_RECEIVED: 'RESOLVING',
    ESCALATION_REQUIRED: 'ESCALATION_PENDING',
    CALLER_HUNG_UP: 'ENDED',
    DEPENDENCY_FAILED: 'FAILED',
  },
  RESOLVING: {
    ANSWER_DELIVERED: 'RESOLVED',
    ESCALATION_REQUIRED: 'ESCALATION_PENDING',
    CALLER_HUNG_UP: 'ENDED',
    DEPENDENCY_FAILED: 'FAILED',
  },
  ESCALATION_PENDING: {
    FOUNDER_PROMPT_DELIVERED: 'FOUNDER_PROMPTED',
    FOUNDER_UNAVAILABLE: 'DEFERRED',
    CALLER_HUNG_UP: 'ENDED',
    DEPENDENCY_FAILED: 'FAILED',
  },
  FOUNDER_PROMPTED: {
    FOUNDER_ANSWERED: 'FOUNDER_RESPONDED',
    FOUNDER_ACCEPTED_HANDOFF: 'HANDOFF',
    FOUNDER_UNAVAILABLE: 'DEFERRED',
    CALLER_HUNG_UP: 'ENDED',
    DEPENDENCY_FAILED: 'FAILED',
  },
  FOUNDER_RESPONDED: {
    RELAY_STARTED: 'RELAYING',
    RELAY_REJECTED_BY_POLICY: 'DEFERRED',
    CALLER_HUNG_UP: 'ENDED',
    DEPENDENCY_FAILED: 'FAILED',
  },
  RELAYING: {
    RELAY_COMPLETED: 'RESOLVED',
    CALLER_HUNG_UP: 'ENDED',
    DEPENDENCY_FAILED: 'FAILED',
  },
  HANDOFF: {
    HANDOFF_COMPLETED: 'ENDED',
    HANDOFF_FAILED: 'DEFERRED',
    CALLER_HUNG_UP: 'ENDED',
    DEPENDENCY_FAILED: 'FAILED',
  },
  RESOLVED: {
    CONVERSATION_ENDED: 'ENDED',
  },
  DEFERRED: {
    CONVERSATION_ENDED: 'ENDED',
  },
  FAILED: {
    RECOVERED_TO_SAFE_STATE: 'DEFERRED',
    CONVERSATION_ENDED: 'ENDED',
  },
  ENDED: {},
};

/** The only state from which nothing further can happen. */
export const TERMINAL_STATE = 'ENDED';

export const ALL_STATES = Object.keys(TRANSITIONS) as ConversationState[];

export const ALL_EVENTS: ConversationEventType[] = [
  'CALL_ANSWERED',
  'CLARIFICATION_ASKED',
  'CLARIFICATION_RECEIVED',
  'RESOLUTION_STARTED',
  'ANSWER_DELIVERED',
  'ESCALATION_REQUIRED',
  'FOUNDER_PROMPT_DELIVERED',
  'FOUNDER_ANSWERED',
  'FOUNDER_ACCEPTED_HANDOFF',
  'FOUNDER_UNAVAILABLE',
  'RELAY_STARTED',
  'RELAY_REJECTED_BY_POLICY',
  'RELAY_COMPLETED',
  'HANDOFF_COMPLETED',
  'HANDOFF_FAILED',
  'CALLER_HUNG_UP',
  'DEPENDENCY_FAILED',
  'RECOVERED_TO_SAFE_STATE',
  'CONVERSATION_ENDED',
];

/**
 * Carried alongside the state. Deliberately minimal: it holds only what the
 * machine itself needs to decide reachability, not general conversation data.
 */
export interface ConversationContext {
  /**
   * CLAUDE.md permits at most one clarification question before Iris must
   * resolve, escalate, or defer. Counting is the machine's job because it is a
   * reachability property, not a matter of reviewer discipline.
   */
  readonly clarificationCount: number;
}

export const INITIAL_CONTEXT: ConversationContext = { clarificationCount: 0 };

export interface TransitionAuditEvent {
  readonly conversationId: string;
  readonly traceId: string;
  readonly from: ConversationState;
  readonly to: ConversationState;
  readonly event: ConversationEventType;
  readonly occurredAt: string;
}

export type TransitionRejection =
  | { readonly reason: 'terminal-state'; readonly message: string }
  | { readonly reason: 'not-allowed'; readonly message: string }
  | { readonly reason: 'clarification-limit'; readonly message: string };

export type TransitionResult =
  | {
      readonly ok: true;
      readonly state: ConversationState;
      readonly context: ConversationContext;
      readonly audit: TransitionAuditEvent;
    }
  | {
      readonly ok: false;
      readonly state: ConversationState;
      readonly context: ConversationContext;
      readonly rejection: TransitionRejection;
    };

export interface TransitionInput {
  readonly state: ConversationState;
  readonly context: ConversationContext;
  readonly event: ConversationEventType;
  readonly conversationId: string;
  readonly traceId: string;
  /** Injected, never read from a clock — the domain must stay deterministic. */
  readonly occurredAt: string;
}

/**
 * Apply an event to a conversation.
 *
 * Returns a result rather than throwing, so the orchestrator has to decide what
 * to do about a rejected transition instead of letting an exception unwind into
 * an unexplained silence for the client. The input is never mutated.
 */
export function transition(input: TransitionInput): TransitionResult {
  const { state, context, event, conversationId, traceId, occurredAt } = input;

  if (state === TERMINAL_STATE) {
    return {
      ok: false,
      state,
      context,
      rejection: {
        reason: 'terminal-state',
        message: `Conversation already ended; refusing ${event}.`,
      },
    };
  }

  const next: ConversationState | undefined = TRANSITIONS[state][event];

  if (next === undefined) {
    return {
      ok: false,
      state,
      context,
      rejection: {
        reason: 'not-allowed',
        message: `${event} is not a legal event in ${state}.`,
      },
    };
  }

  if (event === 'CLARIFICATION_ASKED' && context.clarificationCount >= 1) {
    return {
      ok: false,
      state,
      context,
      rejection: {
        reason: 'clarification-limit',
        message:
          'Only one clarification question is permitted; Iris must now resolve, escalate, or defer.',
      },
    };
  }

  const nextContext: ConversationContext =
    event === 'CLARIFICATION_ASKED'
      ? { clarificationCount: context.clarificationCount + 1 }
      : context;

  return {
    ok: true,
    state: next,
    context: nextContext,
    audit: { conversationId, traceId, from: state, to: next, event, occurredAt },
  };
}

/** Events legal in this state, ignoring context guards. Useful for the UI. */
export function allowedEvents(state: ConversationState): ConversationEventType[] {
  return Object.keys(TRANSITIONS[state]) as ConversationEventType[];
}

export function isTerminal(state: ConversationState): boolean {
  return state === TERMINAL_STATE;
}
