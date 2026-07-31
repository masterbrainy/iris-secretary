/**
 * Dependency-failure recovery.
 *
 * CLAUDE.md: "Any dependency failure (a1mobile, the AI service, Supabase
 * Realtime, the glasses integration) returns Iris to a safe state, captures
 * callback info, creates a follow-up where possible, and alerts the
 * founder/operator. The client is never left in unexplained silence."
 *
 * That sentence is four separate obligations, and the failure mode in practice
 * is honouring three of them and quietly dropping the fourth. This module makes
 * all four fall out of one decision, so none of them can be forgotten
 * individually.
 *
 * Pure: it decides what must happen. Carrying it out is the orchestrator's job.
 */

import type { ConversationState } from './conversation-state.js';
import { assertNever } from './exhaustive.js';

export type DependencyKind = 'telephony' | 'ai-service' | 'realtime' | 'wearable' | 'database';

export function describeDependency(dependency: DependencyKind): string {
  switch (dependency) {
    case 'telephony':
      return 'the phone provider';
    case 'ai-service':
      return 'the AI service';
    case 'realtime':
      return 'the realtime channel';
    case 'wearable':
      return 'the glasses integration';
    case 'database':
      return 'the database';
    default:
      return assertNever(dependency, 'DependencyKind');
  }
}

export interface FailureContext {
  readonly dependency: DependencyKind;
  readonly conversationId: string;
  /** Present when the failure happened during an escalation. */
  readonly escalationId: string | undefined;
  /** True when the caller is still on the line, waiting. */
  readonly clientStillConnected: boolean;
  /** True when we already hold a number we could call back on. */
  readonly callbackKnown: boolean;
  /** Follow-up keys already created for this conversation. */
  readonly existingFollowUpKeys: readonly string[];
  readonly detail: string;
}

export interface OperatorAlert {
  readonly severity: 'warning' | 'critical';
  readonly summary: string;
}

export interface RecoveryPlan {
  /**
   * Where the conversation must end up. `DEFERRED` while the client is still
   * reachable — they are owed an explanation and a follow-up. `ENDED` once
   * they are gone, since there is nobody left to say anything to.
   */
  readonly safeState: Extract<ConversationState, 'DEFERRED' | 'ENDED'>;
  /**
   * True when the client is still connected and we have no number for them.
   * Asking for a callback number is the last chance to keep the thread alive.
   */
  readonly captureCallback: boolean;
  /** True when the client must hear an honest explanation before we hang up. */
  readonly speakToClient: boolean;
  readonly followUpKey: string;
  readonly createFollowUp: boolean;
  readonly alert: OperatorAlert;
  readonly reasons: readonly string[];
}

/**
 * Follow-up key for a failure that happened outside any escalation.
 *
 * Keyed on the conversation so a dependency that fails repeatedly during one
 * call still owes exactly one follow-up, not one per retry.
 */
export function deriveConversationFollowUpKey(conversationId: string): string {
  return `follow-up:conversation:${conversationId}`;
}

export function planRecovery(context: FailureContext): RecoveryPlan {
  const {
    dependency,
    conversationId,
    escalationId,
    clientStillConnected,
    callbackKnown,
    existingFollowUpKeys,
    detail,
  } = context;

  const followUpKey =
    escalationId === undefined
      ? deriveConversationFollowUpKey(conversationId)
      : `follow-up:${escalationId}`;

  const alreadyCreated = existingFollowUpKeys.includes(followUpKey);
  const what = describeDependency(dependency);

  const reasons: string[] = [`${what} failed: ${detail}`];

  if (clientStillConnected) {
    reasons.push('The client is still on the line and must hear an honest explanation.');
  } else {
    reasons.push('The client is no longer connected, so the conversation ends here.');
  }

  const captureCallback = clientStillConnected && !callbackKnown;
  if (captureCallback) {
    reasons.push('No callback number on file — asking for one before the line drops.');
  }

  if (alreadyCreated) {
    reasons.push('A follow-up already exists for this conversation; not creating another.');
  } else {
    reasons.push('Creating exactly one follow-up so this gets picked back up.');
  }

  return {
    safeState: clientStillConnected ? 'DEFERRED' : 'ENDED',
    captureCallback,
    speakToClient: clientStillConnected,
    followUpKey,
    createFollowUp: !alreadyCreated,
    alert: {
      // A failure with someone waiting on the line is materially worse than one
      // discovered after they hung up, and the founder should see the
      // difference at a glance.
      severity: clientStillConnected ? 'critical' : 'warning',
      summary: clientStillConnected
        ? `${what} failed mid-conversation with the client still on the line.`
        : `${what} failed after the client had disconnected.`,
    },
    reasons,
  };
}
