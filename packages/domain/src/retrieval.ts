/**
 * Knowledge retrieval.
 *
 * Two jobs, kept apart on purpose:
 *
 *  1. **Rank** — which approved entries look like they answer this question.
 *  2. **Select** — decide whether any of them may actually be used, and with
 *     what confidence.
 *
 * The second is where the safety lives. Scope and approval are applied *before*
 * an answer is composed, not merely subtracted from the reported source list —
 * otherwise a customer-specific entry could shape the words Cynthia says while
 * being invisible in the audit trail, which is the worst of both.
 *
 * Pure and deterministic: ranking is lexical and computed over the candidate
 * set it is given, so the same inputs always produce the same ordering.
 */

import {
  isUsableForCaller,
  type CallerIdentity,
  type KnowledgeScope,
  type KnowledgeStatus,
} from './policy.js';

export interface KnowledgeItem {
  readonly knowledgeItemId: string;
  readonly title: string;
  readonly answer: string;
  readonly status: KnowledgeStatus;
  readonly scope: KnowledgeScope;
  /** Extra retrieval surface — synonyms the answer text does not contain. */
  readonly keywords: readonly string[];
}

export interface RankedItem {
  readonly item: KnowledgeItem;
  /** 0..1 — the share of the question's information content this item covers. */
  readonly score: number;
}

/**
 * Words carrying no retrieval signal.
 *
 * Interrogatives are included, which was not obvious: they distinguish kinds of
 * *question*, but the knowledge base is a corpus of declarative *answers*, so
 * they encode nothing. Leaving them in made an entry titled "How to reach us"
 * the top hit for "how long is the warranty", because "how" appeared in exactly
 * one entry and was therefore treated as highly discriminating.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'that',
  'the',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'their',
  'there',
  'this',
  'to',
  'we',
  'with',
  'you',
  'your',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function itemTokens(item: KnowledgeItem): Set<string> {
  return new Set([
    ...tokenize(item.title),
    ...tokenize(item.answer),
    ...item.keywords.flatMap((keyword) => tokenize(keyword)),
  ]);
}

/**
 * Rank items by how much of the question's information content they cover,
 * weighting rare terms above common ones.
 *
 * A term appearing in every entry ("hours" in an FAQ full of hours) tells you
 * nothing about which entry is right, so it is discounted; a term appearing in
 * one entry is close to decisive.
 */
export function rankItems(query: string, items: readonly KnowledgeItem[]): RankedItem[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || items.length === 0) {
    return items.map((item) => ({ item, score: 0 }));
  }

  // Tokenise once and carry the tokens alongside the item, so scoring never
  // has to index back into a parallel array.
  const entries = items.map((item) => ({ item, tokens: itemTokens(item) }));

  function inverseDocumentFrequency(term: string): number {
    const containing = entries.filter((entry) => entry.tokens.has(term)).length;
    // +1 keeps a term present in every item at a small but non-zero weight.
    return Math.log((items.length + 1) / (containing + 1)) + 1;
  }

  const weights = new Map(queryTerms.map((term) => [term, inverseDocumentFrequency(term)]));
  const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);

  return entries
    .map(({ item, tokens }) => {
      const matched = queryTerms
        .filter((term) => tokens.has(term))
        .reduce((sum, term) => sum + (weights.get(term) ?? 0), 0);
      return { item, score: totalWeight === 0 ? 0 : matched / totalWeight };
    })
    .sort((a, b) =>
      // Ties break on id so ordering is stable and reproducible.
      b.score === a.score
        ? a.item.knowledgeItemId.localeCompare(b.item.knowledgeItemId)
        : b.score - a.score,
    );
}

export interface RetrievalConfig {
  /** Below this a hit is not considered a match at all. */
  readonly minScore: number;
  /**
   * When the runner-up scores at least this fraction of the leader, the two are
   * treated as indistinguishable and confidence is cut.
   */
  readonly ambiguityRatio: number;
  readonly ambiguityPenalty: number;
}

export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  minScore: 0.34,
  ambiguityRatio: 0.85,
  ambiguityPenalty: 0.5,
};

export interface RetrievalOutcome {
  /** The answer text, drawn only from usable sources. */
  readonly answer: string | undefined;
  /** CLAUDE.md: every generated answer retains the IDs of its sources. */
  readonly sourceIds: readonly string[];
  readonly answerConfidence: number;
  /** Usable, ranked, above threshold. Handed to the policy gate. */
  readonly usable: readonly RankedItem[];
  /** Ranked hits that existed but could not be used, and why. */
  readonly excluded: readonly { readonly item: KnowledgeItem; readonly reason: string }[];
  readonly reasons: readonly string[];
}

/**
 * Choose an answer for this caller.
 *
 * Approval and scope are applied first, so an entry the caller may not see
 * never reaches the text. Confidence then reflects two things: how well the
 * best usable entry covers the question, and whether a second entry covers it
 * just as well — because "I found two equally good answers" is not confidence,
 * it is ambiguity, and it should escalate rather than guess.
 */
export function selectAnswer(
  query: string,
  items: readonly KnowledgeItem[],
  caller: CallerIdentity,
  config: RetrievalConfig = DEFAULT_RETRIEVAL,
): RetrievalOutcome {
  const ranked = rankItems(query, items);

  const excluded: { item: KnowledgeItem; reason: string }[] = [];
  const usable: RankedItem[] = [];

  for (const hit of ranked) {
    if (hit.score < config.minScore) continue;
    if (!isUsableForCaller(hit.item, caller)) {
      excluded.push({
        item: hit.item,
        reason:
          hit.item.status === 'approved'
            ? 'Scoped to a different caller.'
            : `Not approved (${hit.item.status}).`,
      });
      continue;
    }
    usable.push(hit);
  }

  const [best, runnerUp] = usable;

  if (best === undefined) {
    return {
      answer: undefined,
      sourceIds: [],
      answerConfidence: 0,
      usable: [],
      excluded,
      reasons: [
        excluded.length > 0
          ? 'Matching knowledge exists but none of it is approved and in scope for this caller.'
          : 'Nothing in the approved knowledge base covers this.',
      ],
    };
  }

  const ambiguous =
    runnerUp !== undefined &&
    best.score > 0 &&
    runnerUp.score / best.score >= config.ambiguityRatio;

  const answerConfidence = ambiguous ? best.score * config.ambiguityPenalty : best.score;

  const reasons = [
    `Best match "${best.item.title}" covers ${(best.score * 100).toFixed(0)}% of the question.`,
  ];
  if (ambiguous) {
    reasons.push(
      `"${runnerUp.item.title}" matches almost as well, so it is unclear which one answers this — confidence reduced.`,
    );
  }
  if (excluded.length > 0) {
    reasons.push(
      `${String(excluded.length)} matching entr${excluded.length === 1 ? 'y was' : 'ies were'} withheld as out of scope or unapproved.`,
    );
  }

  return {
    answer: best.item.answer,
    sourceIds: [best.item.knowledgeItemId],
    answerConfidence,
    usable,
    excluded,
    reasons,
  };
}
