/**
 * The escalation packet — what the founder actually receives.
 *
 * This is spoken into someone's ear mid-day, or read on a phone between
 * meetings, so it has to be short and complete at the same time. The PRD fixes
 * its contents; CLAUDE.md fixes how priority is allowed to be decided.
 *
 * Pure: `issuedAt` is injected and the expiry is computed from it. Reading the
 * clock is impure, but arithmetic on a timestamp you were handed is not.
 */

import { assertNever } from './exhaustive.js';

export type Priority = 'critical' | 'high' | 'normal' | 'low';

export type RelationshipStatus = 'unknown' | 'new' | 'known' | 'active-client' | 'former-client';

export type Urgency = 'routine' | 'time-sensitive' | 'urgent';

/**
 * The configured signals CLAUDE.md permits priority to be derived from.
 * Nothing else may influence it — priority has to be explainable, which means
 * every input to it is named here and every one that fires produces a reason.
 */
export interface PrioritySignals {
  readonly isVip: boolean;
  readonly relationship: RelationshipStatus;
  readonly hasActiveDeal: boolean;
  readonly recognizedOrganization: string | undefined;
  readonly urgency: Urgency;
  /** False when we could not identify the caller at all. */
  readonly isKnownCaller: boolean;
}

export interface PriorityAssessment {
  readonly priority: Priority;
  /** Human-readable, shown in the founder console and the audit timeline. */
  readonly reasons: readonly string[];
}

function relationshipWeight(relationship: RelationshipStatus): number {
  switch (relationship) {
    case 'active-client':
      return 2;
    case 'known':
    case 'former-client':
      return 1;
    case 'new':
    case 'unknown':
      return 0;
    default:
      return assertNever(relationship, 'RelationshipStatus');
  }
}

function urgencyWeight(urgency: Urgency): number {
  switch (urgency) {
    case 'urgent':
      return 3;
    case 'time-sensitive':
      return 1;
    case 'routine':
      return 0;
    default:
      return assertNever(urgency, 'Urgency');
  }
}

/**
 * Score the configured signals, then apply the one hard rule:
 *
 * **An unknown caller is never low priority merely for being unknown.**
 * Not knowing who someone is tells you nothing about whether they matter, so
 * an unidentified caller floors at `normal`. Implemented as an explicit floor
 * rather than by fiddling with weights, so it cannot be quietly tuned away and
 * the founder can see it was applied.
 */
export function assessPriority(signals: PrioritySignals): PriorityAssessment {
  const reasons: string[] = [];
  let score = 0;

  if (signals.isVip) {
    score += 3;
    reasons.push('Configured as a VIP.');
  }
  if (signals.hasActiveDeal) {
    score += 2;
    reasons.push('Has an active deal in progress.');
  }
  if (signals.recognizedOrganization !== undefined) {
    score += 1;
    reasons.push(`Calling from a recognised organisation (${signals.recognizedOrganization}).`);
  }

  const relWeight = relationshipWeight(signals.relationship);
  if (relWeight > 0) {
    score += relWeight;
    reasons.push(
      signals.relationship === 'active-client'
        ? 'An active client.'
        : `Relationship on file: ${signals.relationship}.`,
    );
  }

  const urgWeight = urgencyWeight(signals.urgency);
  if (urgWeight > 0) {
    score += urgWeight;
    reasons.push(signals.urgency === 'urgent' ? 'Flagged urgent.' : 'Time-sensitive request.');
  }

  let priority: Priority =
    score >= 6 ? 'critical' : score >= 3 ? 'high' : score >= 1 ? 'normal' : 'low';

  if (!signals.isKnownCaller && priority === 'low') {
    priority = 'normal';
    reasons.push(
      'Caller could not be identified — treated as normal rather than low, because not knowing who someone is says nothing about whether they matter.',
    );
  }

  if (reasons.length === 0) {
    reasons.push('No priority signals configured for this caller.');
  }

  return { priority, reasons };
}

export type FounderAction = 'answer' | 'decline' | 'defer' | 'take-call';

export interface CallerSummary {
  readonly contactId: string | undefined;
  readonly displayName: string;
  readonly organizationName: string | undefined;
  readonly phoneNumber: string | undefined;
}

export interface EscalationPacket {
  readonly escalationId: string;
  readonly conversationId: string;
  readonly traceId: string;
  readonly caller: CallerSummary;
  readonly relationship: RelationshipStatus;
  readonly priority: Priority;
  readonly priorityReasons: readonly string[];
  readonly intent: string;
  /** The client's question, exactly as asked. Never truncated or reworded. */
  readonly question: string;
  /** At most 40 words, per the PRD. */
  readonly context: string;
  readonly contextTruncated: boolean;
  readonly recommendedAnswer: string | undefined;
  readonly allowedActions: readonly FounderAction[];
  readonly expiresAt: string;
}

export const MAX_CONTEXT_WORDS = 40;

/**
 * Clamp context to the PRD's 40-word limit.
 *
 * Truncates visibly rather than rejecting: context is assembled from a live
 * transcript and overshooting is normal, but the founder must be able to tell
 * that they are seeing an excerpt rather than the whole story.
 */
export function clampContext(text: string): { context: string; truncated: boolean } {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length <= MAX_CONTEXT_WORDS) {
    return { context: words.join(' '), truncated: false };
  }
  return { context: `${words.slice(0, MAX_CONTEXT_WORDS).join(' ')}…`, truncated: true };
}

export type PacketRejectionReason =
  | 'missing-escalation-id'
  | 'missing-conversation-id'
  | 'missing-question'
  | 'invalid-ttl'
  | 'invalid-issued-at';

export type PacketResult =
  | { readonly ok: true; readonly packet: EscalationPacket }
  | { readonly ok: false; readonly reason: PacketRejectionReason; readonly message: string };

export interface PacketInput {
  readonly escalationId: string;
  readonly conversationId: string;
  readonly traceId: string;
  readonly caller: CallerSummary;
  readonly signals: PrioritySignals;
  readonly intent: string;
  readonly question: string;
  readonly context: string;
  readonly recommendedAnswer?: string | undefined;
  /**
   * Whether transferring the call is even possible. False for SMS, and false
   * while the provider's transfer capability is `pending`, so the founder is
   * never offered an action that cannot be carried out.
   */
  readonly handoffAvailable: boolean;
  /** Injected. */
  readonly issuedAt: string;
  readonly ttlMs: number;
}

export function buildEscalationPacket(input: PacketInput): PacketResult {
  if (input.escalationId.trim() === '') {
    return {
      ok: false,
      reason: 'missing-escalation-id',
      message: 'An escalation packet needs its own id so the founder’s reply can be matched to it.',
    };
  }
  if (input.conversationId.trim() === '') {
    return {
      ok: false,
      reason: 'missing-conversation-id',
      message: 'An escalation packet needs the conversation it belongs to.',
    };
  }
  if (input.question.trim() === '') {
    return {
      ok: false,
      reason: 'missing-question',
      message: 'There is no point prompting the founder without the question.',
    };
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    return {
      ok: false,
      reason: 'invalid-ttl',
      message: 'An escalation must expire, or a client waits on hold forever.',
    };
  }

  const issuedMs = new Date(input.issuedAt).getTime();
  if (Number.isNaN(issuedMs)) {
    return {
      ok: false,
      reason: 'invalid-issued-at',
      message: `Could not parse issuedAt: ${input.issuedAt}`,
    };
  }

  const { priority, reasons } = assessPriority(input.signals);
  const { context, truncated } = clampContext(input.context);

  const allowedActions: FounderAction[] = input.handoffAvailable
    ? ['answer', 'decline', 'defer', 'take-call']
    : ['answer', 'decline', 'defer'];

  return {
    ok: true,
    packet: {
      escalationId: input.escalationId,
      conversationId: input.conversationId,
      traceId: input.traceId,
      caller: input.caller,
      relationship: input.signals.relationship,
      priority,
      priorityReasons: reasons,
      intent: input.intent,
      question: input.question,
      context,
      contextTruncated: truncated,
      recommendedAnswer: input.recommendedAnswer,
      allowedActions,
      expiresAt: new Date(issuedMs + input.ttlMs).toISOString(),
    },
  };
}
