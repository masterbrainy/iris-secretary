/**
 * Policy gates.
 *
 * These encode the promises in CLAUDE.md that are easiest to erode under
 * delivery pressure and hardest to notice when they break:
 *
 *  - Some categories always escalate and are never executed autonomously.
 *  - A founder timeout defers honestly; it never fabricates an answer, and it
 *    creates exactly one follow-up.
 *  - A direct handoff happens only on explicit founder acceptance.
 *  - At most one clarification question.
 *  - Customer-specific knowledge never leaks to a different caller.
 *
 * Every gate returns readable reasons alongside its decision, because the
 * founder console has to show *why* Cynthia did what it did, and an audit
 * timeline of bare booleans is not an explanation.
 *
 * Pure: classification of natural language (is this a refund request?) is an
 * AI-service concern and happens upstream. These functions consume already-
 * detected signals and decide what to do about them.
 */

import { assertNever } from './exhaustive.js';

/**
 * CLAUDE.md, Scope: "Out — these always escalate, never execute autonomously."
 * This list is the machine-readable form of that sentence.
 */
export type SensitiveCategory =
  | 'negotiation'
  | 'purchase'
  | 'refund'
  | 'commitment'
  | 'professional-advice'
  | 'security-sensitive';

export const SENSITIVE_CATEGORIES: readonly SensitiveCategory[] = [
  'negotiation',
  'purchase',
  'refund',
  'commitment',
  'professional-advice',
  'security-sensitive',
];

export function describeSensitiveCategory(category: SensitiveCategory): string {
  switch (category) {
    case 'negotiation':
      return 'negotiating terms';
    case 'purchase':
      return 'making a purchase';
    case 'refund':
      return 'issuing a refund';
    case 'commitment':
      return 'committing on the founder’s behalf';
    case 'professional-advice':
      return 'giving professional advice';
    case 'security-sensitive':
      return 'a security-sensitive change';
    default:
      return assertNever(category, 'SensitiveCategory');
  }
}

/**
 * Where a piece of knowledge may be used.
 *
 * `contact` and `caller-organization` exist so customer-specific information
 * stays with that customer. A price negotiated with one client must never be
 * quoted to another, and the only reliable way to guarantee that is to make
 * scope a property of the knowledge itself rather than a retrieval heuristic.
 */
export type KnowledgeScope =
  | { readonly kind: 'general' }
  | { readonly kind: 'contact'; readonly contactId: string }
  | { readonly kind: 'caller-organization'; readonly callerOrganizationId: string };

export type KnowledgeStatus = 'approved' | 'proposed' | 'rejected' | 'archived';

export interface KnowledgeCandidate {
  readonly knowledgeItemId: string;
  readonly status: KnowledgeStatus;
  readonly scope: KnowledgeScope;
}

export interface CallerIdentity {
  readonly contactId: string | undefined;
  readonly callerOrganizationId: string | undefined;
}

/** A candidate is usable only if it is approved AND in scope for this caller. */
export function isUsableForCaller(candidate: KnowledgeCandidate, caller: CallerIdentity): boolean {
  if (candidate.status !== 'approved') return false;

  const { scope } = candidate;
  switch (scope.kind) {
    case 'general':
      return true;
    case 'contact':
      return caller.contactId !== undefined && caller.contactId === scope.contactId;
    case 'caller-organization':
      return (
        caller.callerOrganizationId !== undefined &&
        caller.callerOrganizationId === scope.callerOrganizationId
      );
    default:
      return assertNever(scope, 'KnowledgeScope');
  }
}

export interface PolicyConfig {
  /** Below this, Cynthia must not answer directly. */
  readonly minAnswerConfidence: number;
  /**
   * Below this, a critical detail (name, date, price, commitment) must be
   * confirmed rather than acted on. CLAUDE.md, Security.
   */
  readonly minTranscriptionConfidence: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  minAnswerConfidence: 0.75,
  minTranscriptionConfidence: 0.7,
};

export interface ResolutionRequest {
  readonly caller: CallerIdentity;
  readonly candidates: readonly KnowledgeCandidate[];
  /** Confidence that the retrieved knowledge actually answers the question. */
  readonly answerConfidence: number;
  /** Sensitive categories detected upstream by the AI service. */
  readonly detectedCategories: readonly SensitiveCategory[];
  readonly transcriptionConfidence: number;
  /** Whether the request turns on a name, date, price, or commitment. */
  readonly involvesCriticalDetail: boolean;
  /** How many clarification questions have already been asked. */
  readonly clarificationCount: number;
  readonly policy: PolicyConfig;
}

export type ResolutionDecision =
  | {
      readonly action: 'answer';
      /** CLAUDE.md: every generated answer retains the IDs of its sources. */
      readonly sourceIds: readonly string[];
      readonly reasons: readonly string[];
    }
  | { readonly action: 'confirm'; readonly reasons: readonly string[] }
  | { readonly action: 'escalate'; readonly reasons: readonly string[] };

/**
 * Decide how to handle a client request.
 *
 * Gate order is deliberate and load-bearing. Sensitivity is checked first, so
 * a confident, well-sourced answer about a refund still escalates — being sure
 * about a refund is not authorisation to issue one.
 */
export function decideResolution(request: ResolutionRequest): ResolutionDecision {
  const {
    caller,
    candidates,
    answerConfidence,
    detectedCategories,
    transcriptionConfidence,
    involvesCriticalDetail,
    clarificationCount,
    policy,
  } = request;

  // 1. Sensitive categories always escalate, regardless of everything below.
  if (detectedCategories.length > 0) {
    const named = detectedCategories.map(describeSensitiveCategory).join(', ');
    return {
      action: 'escalate',
      reasons: [`This involves ${named}, which is never handled without the founder.`],
    };
  }

  // 2. A critical detail heard poorly must be confirmed, not guessed at. If the
  //    one clarification is already spent, escalate rather than act on a guess.
  if (involvesCriticalDetail && transcriptionConfidence < policy.minTranscriptionConfidence) {
    if (clarificationCount >= 1) {
      return {
        action: 'escalate',
        reasons: [
          'A critical detail was not heard clearly and the one clarification question has already been used.',
        ],
      };
    }
    return {
      action: 'confirm',
      reasons: [
        `A name, date, price, or commitment was heard with low confidence (${transcriptionConfidence.toFixed(2)}); confirming rather than acting on a guess.`,
      ],
    };
  }

  // 3. Only approved, in-scope knowledge may be used.
  const usable = candidates.filter((c) => isUsableForCaller(c, caller));
  if (usable.length === 0) {
    const hadUnusable = candidates.length > 0;
    return {
      action: 'escalate',
      reasons: [
        hadUnusable
          ? 'No approved knowledge in scope for this caller — the founder has to answer this one.'
          : 'Nothing in the approved knowledge base covers this.',
      ],
    };
  }

  // 4. Confidence threshold.
  if (answerConfidence < policy.minAnswerConfidence) {
    return {
      action: 'escalate',
      reasons: [
        `Confidence ${answerConfidence.toFixed(2)} is below the ${policy.minAnswerConfidence.toFixed(2)} threshold for answering directly.`,
      ],
    };
  }

  return {
    action: 'answer',
    sourceIds: usable.map((c) => c.knowledgeItemId),
    reasons: [
      `Answered from ${String(usable.length)} approved source${usable.length === 1 ? '' : 's'} in scope for this caller.`,
    ],
  };
}

export type GateResult =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** CLAUDE.md: at most one clarification before resolving, escalating, or deferring. */
export function canAskClarification(clarificationCount: number): GateResult {
  if (clarificationCount >= 1) {
    return {
      allowed: false,
      reason:
        'One clarification question has already been asked; Cynthia must now resolve, escalate, or defer.',
    };
  }
  return { allowed: true };
}

/**
 * What the founder did with an escalation.
 *
 * `take-call` is a distinct, explicit signal — it is never derived from the
 * text of an answer. Interpreting "sure, put them through" out of a verbal
 * reply is exactly the inference CLAUDE.md forbids, so the adapter must map an
 * explicit affordance (a button, a recognised command) onto this variant, and
 * the domain refuses to guess.
 */
export type FounderReply =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'take-call' }
  | { readonly kind: 'decline' }
  | { readonly kind: 'defer' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'undeliverable' };

export interface HandoffDecision {
  readonly accepted: boolean;
  readonly reason: string;
}

/** Direct handoff requires explicit acceptance — never silence, never a guess. */
export function decideHandoff(reply: FounderReply): HandoffDecision {
  switch (reply.kind) {
    case 'take-call':
      return { accepted: true, reason: 'The founder explicitly accepted taking the call.' };
    case 'answer':
      return {
        accepted: false,
        reason:
          'The founder gave an answer to relay, not an acceptance. Handoff is never inferred from the wording of a reply.',
      };
    case 'decline':
      return { accepted: false, reason: 'The founder declined.' };
    case 'defer':
      return { accepted: false, reason: 'The founder deferred.' };
    case 'timeout':
      return {
        accepted: false,
        reason: 'The founder did not respond. Silence is never acceptance.',
      };
    case 'undeliverable':
      return {
        accepted: false,
        reason: 'The prompt never reached the founder, so there is nothing to accept.',
      };
    default:
      return assertNever(reply, 'FounderReply');
  }
}

export type DeferralCause =
  | 'founder-timeout'
  | 'founder-declined'
  | 'founder-deferred'
  | 'prompt-undeliverable'
  | 'dependency-failure'
  | 'policy-rejected-answer';

export function describeDeferralCause(cause: DeferralCause): string {
  switch (cause) {
    case 'founder-timeout':
      return 'the founder did not respond in time';
    case 'founder-declined':
      return 'the founder declined to answer';
    case 'founder-deferred':
      return 'the founder chose to follow up later';
    case 'prompt-undeliverable':
      return 'the question could not be delivered to the founder';
    case 'dependency-failure':
      return 'a dependency failed while handling the request';
    case 'policy-rejected-answer':
      return 'the answer could not be relayed as given';
    default:
      return assertNever(cause, 'DeferralCause');
  }
}

/**
 * Deterministic key for the follow-up owed by a deferral.
 *
 * Keyed on the escalation rather than on an inbound provider event, because a
 * timeout is our own timer firing, not something a provider told us. One
 * escalation therefore owes at most one follow-up, by construction.
 */
export function deriveFollowUpKey(escalationId: string): string {
  return `follow-up:${escalationId}`;
}

export interface DeferralPlan {
  readonly cause: DeferralCause;
  readonly followUpKey: string;
  /** False when this escalation already produced its follow-up. */
  readonly createFollowUp: boolean;
  /**
   * Always false. Present so the shape makes the rule explicit at the call
   * site: a deferral never carries an answer. CLAUDE.md — a founder timeout
   * produces a deferred response, never a fabricated one.
   */
  readonly answerToClient: null;
  readonly reasons: readonly string[];
}

export interface DeferralInput {
  readonly escalationId: string;
  readonly cause: DeferralCause;
  /** Follow-up keys already created for this conversation. */
  readonly existingFollowUpKeys: readonly string[];
}

export function planDeferral(input: DeferralInput): DeferralPlan {
  const followUpKey = deriveFollowUpKey(input.escalationId);
  const alreadyCreated = input.existingFollowUpKeys.includes(followUpKey);

  return {
    cause: input.cause,
    followUpKey,
    createFollowUp: !alreadyCreated,
    answerToClient: null,
    reasons: [
      `Deferring because ${describeDeferralCause(input.cause)}.`,
      alreadyCreated
        ? 'A follow-up already exists for this escalation; not creating another.'
        : 'Creating exactly one follow-up so this is picked back up.',
    ],
  };
}
