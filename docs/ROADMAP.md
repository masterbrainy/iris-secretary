# ROADMAP

Ordered execution plan derived from docs/PRD.md → IMPLEMENTATION INSTRUCTIONS, reordered per CLAUDE.md invariants: state machine and tests before production channels; migrations and RLS before adapters; adapters and simulators before UI; scenario tests before "done." One item per pass. Tick the box only when the item is implemented, tested, and merged.

Rules of the road (from CLAUDE.md — repeated here because every item is subject to them):

- Never invent an undocumented provider endpoint or assume an unverified device capability. Typed contract + pending marker + deterministic simulator is the correct move when docs/credentials are absent.
- Every state transition is an audit event; every inbound provider event is idempotent — including in simulators.
- Work on a branch per item; PR when a remote exists (see docs/NEEDS-USER.md), local merge with `--no-ff` until then.
- Append judgment calls to docs/DECISIONS-LOG.md as you go.

## Phase 0 — Bootstrap

- [x] 0.1 Repo inspection, git init, docs/architecture.md (what exists / what doesn't), this roadmap, DECISIONS-LOG.md, NEEDS-USER.md

## Phase 1 — De-risk the unknowns

- [x] 1.1 **Meta Wearables spike (desk portion)** → [meta-wearable-spike.md](meta-wearable-spike.md). Capability matrix, MetaWearableAdapter contract shape, hardware-only list, and six ordered experiments. Headline: **DAT exposes no audio API at all** — Cynthia's audio-only flow is a Bluetooth-headset problem, so the toolkit may not be on the critical path (experiment E1 decides). Hands-free delivery is plausible on Android, unsupported-as-designed on iOS. iOS App Store publication is blocked outright. Device-dependent items remain unverified — desk-only, no hardware or account (NEEDS-USER.md §3).
- [x] 1.2 **a1mobile capability audit** → recorded in architecture.md §2. Finding: **no public developer API exists**; a1mobile is a competitor-shaped AI-receptionist carrier, not a CPaaS. No credentials in repo. Every A1MobileAdapter capability is therefore `pending`, backed by the simulator. Contract _freezing_ happens in 4.1 against the Twilio/Telnyx public reference shape. Open commercial question escalated in NEEDS-USER.md §1.

## Phase 2 — Foundation (no provider code yet)

- [x] 2.1 Monorepo scaffold: pnpm 11 workspaces + TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`); apps/web, apps/api, packages/domain, packages/adapters, supabase/, tests/e2e, docs. Prettier + ESLint 10 flat config + Vitest 4 projects + `tsc --build`, all behind one `pnpm run check`. **All five gates verified by deliberately breaking each one** — type error, domain I/O import, `new Date()` in domain, unformatted code, failing assertion. `packages/domain` purity is enforced by lint, not convention.
- [x] 2.2 **packages/domain: conversation state machine.** All 13 states with the transition table written out in full, invalid transitions rejected via a result type (never thrown), a typed audit event per accepted transition, pure and deterministic (time and IDs injected). 34 tests covering the PRD demo flows, structural graph properties (every state reachable from RINGING; every state can reach ENDED), and the CLAUDE.md invariants. **Six invariants verified by breaking the code** — second clarification, handoff without acceptance, orphaned state, stranded client, non-terminal ENDED, context mutation — all caught.
- [x] 2.3 **packages/domain: inbound-event envelope.** Trace ID, provider event ID, raw-event reference (storage key + content hash + byte length), and idempotency key derived from `provider:providerEventId` — never from payload content, so a provider retry with a cosmetically different body is still recognised as the same event. Two layers: hard dedupe of repeat deliveries, plus deterministic **side-effect keys** (`<envelopeKey>#<kind>[#discriminator]`) so a replay after a crash still produces the same key and the provider dedupes on its side. Out-of-order arrival is flagged but still processed — the state machine, not provider ordering, is the authority on legality. 21 tests; **six guarantees verified by breaking the code**.
- [x] 2.4 **packages/domain: policy gates.** Direct-answer preconditions (approved status, caller-scope match, confidence threshold, no sensitive trigger) with **deliberate gate ordering** — sensitivity is checked first, so a maximally confident well-sourced refund still escalates. Sensitive list from CLAUDE.md's scope boundary; one-clarification limit; low-confidence critical details are confirmed rather than guessed (and escalate once the clarification is spent); handoff accepted only from an explicit typed signal, never from reply wording or silence; deferral carries `answerToClient: null` and derives one follow-up key per escalation. Every decision returns readable reasons for the audit timeline. 27 tests; **eight guarantees verified by breaking the code**.
- [x] 2.5 **Escalation packet builder.** Everything the PRD requires, plus priority derived only from CLAUDE.md's named signals with a readable reason per signal that fired. **The unknown-caller floor is an explicit rule, not a scoring accident** — an unidentified caller can never land on `low`, and the packet says so. Question is kept verbatim; context clamps to 40 words and flags that it is an excerpt; `take-call` is offered only when a transfer is actually possible; an escalation without an expiry is refused outright. 25 tests; **seven guarantees verified by breaking the code**.

## Phase 3 — Data layer

> **Blocked on Docker (2026-07-31).** `supabase start` needs a container runtime and none is
> installed (docs/NEEDS-USER.md §4). Rather than stall, phase 4 (adapters + simulators) is being
> taken first — it depends only on `packages/domain`, so nothing is lost by the reorder. Phase 3
> resumes as soon as a runtime is available; say the word and colima goes in via Homebrew.

- [ ] 3.1 Supabase local stack (CLI + Docker), migrations for all 14 core tables (organizations, users, contacts, relationships, conversations, messages, escalations, founder_responses, knowledge_items, knowledge_versions, knowledge_proposals, tool_runs, follow_ups, audit_events) with provider event IDs, knowledge source refs, state, scope, sensitivity, idempotency keys, timestamps.
- [ ] 3.2 RLS on every tenant-owned table via organization_id — no exceptions. RLS tests that prove cross-org reads/writes fail. Service-role usage confined to apps/api server code.
- [ ] 3.3 Seed data: one org, founder user, contacts (VIP + unknown), approved knowledge items covering the "routine questions" demo set, generated TypeScript types.

## Phase 4 — Adapters + simulators

- [x] 4.1 **A1MobileAdapter typed contract + A1MobileSimulator.** Contract specified against the documented Twilio/Telnyx lifecycle in the async command/webhook shape; **no a1mobile endpoint is asserted anywhere**. All eight capabilities `pending`; the production adapter implements the full contract and refuses every operation with a typed `capability-pending` failure rather than throwing or faking. The simulator does not shortcut the pipeline — it emits signed `RawWebhookDelivery` objects that callers feed through `verifyAndParse`, so verification, envelope construction and dedupe are genuinely exercised. Deterministic clock and counters; scriptable duplicates, out-of-order delivery, and provider outage. 20 tests; **eight guarantees verified by breaking the code**.
- [ ] 4.2 MetaWearableAdapter typed contract (from 1.1) + **MetaWearableSimulator**: prompt delivery, verbal answer / decline / defer / take-call responses carrying escalation ID, timeout, offline/disconnected mode.
- [ ] 4.3 Failure-mode harness: each adapter can simulate provider outage; orchestrator must reach safe state, capture callback info, create follow-up, alert founder/operator. (Client never in unexplained silence.)

## Phase 5 — Orchestrator (apps/api)

- [ ] 5.1 Orchestrator service: single deterministic loop wiring state machine + intake + retrieval + resolution + escalation + relay + knowledge curation as internal modules. Persists every transition as audit_events row; idempotent event ingestion using 2.3.
- [ ] 5.2 Knowledge retrieval: approved-only, caller-scope-aware, confidence-thresholded; every generated answer records the knowledge_item IDs it used. pgvector only if plain search proves insufficient on the seed set (log the decision either way).
- [ ] 5.3 Escalation flow end-to-end against simulators: hold phrase → packet → founder prompt (target ≤3s from decision) → verbal answer → policy check → relay (target ≤1s from submit) → RESOLVED. Founder timeout → DEFERRED + honest next step + exactly one follow_up.
- [ ] 5.4 Knowledge curation: founder answer → knowledge_proposal (atomic answer, title, scope, source conversation, timestamp, sensitivity, risk, confidence, contradiction status). Contradiction → review item, never overwrite. Customer-specific stays contact/org-scoped.
- [ ] 5.5 Follow-ups + scheduling tool as the one allow-listed tool: typed input, authorization, timeout, idempotency key on the side effect.

## Phase 6 — UI

- [ ] 6.1 apps/web founder console: live escalation inbox (Supabase Realtime), answer / defer / decline / take-call controls, conversation history, audit timeline, contact context, knowledge review (approve/reject proposals, contradiction queue), availability mode, integration status.
- [ ] 6.2 Client simulator UI: run the full experience locally with zero paid services/hardware; shows live conversation state; buttons to fire simulated a1mobile events (call, SMS, duplicate webhook, outage) and Meta glasses events (answer, decline, defer, take-call, timeout, offline).

## Phase 7 — Required scenario tests (each is a gate; none may be skipped)

- [ ] 7.1 Direct answer from approved knowledge (no founder involvement)
- [ ] 7.2 Clarification: exactly one question, then resolve/escalate/defer
- [ ] 7.3 Live relay: escalate → founder verbal answer → relayed to client
- [ ] 7.4 Founder timeout: deferred response, no fabricated answer, exactly one follow-up
- [ ] 7.5 Knowledge reuse: approve captured answer → same question resolves without escalation
- [ ] 7.6 Sensitive escalation: out-of-scope categories always escalate, never execute
- [ ] 7.7 Duplicate webhook: no duplicated message/transfer/booking/follow-up
- [ ] 7.8 Provider outage: safe state, callback captured, follow-up created, founder alerted

## Phase 8 — Handoff

- [ ] 8.1 Demo script (three consecutive scenarios per PRD DELIVERABLES) + .env.example + setup instructions in README
- [ ] 8.2 Full gate: format, typecheck, unit, integration, e2e all green; docs/architecture.md and meta-wearable-spike.md current; honest status report of anything pending

## Discovered work (append as found)

- [ ] D.1 Recording/transcription disclosure config + per-data-class retention policy fields (PRD Security — implied schema + orchestrator work; fold into 3.1/5.1)
- [ ] D.2 Capability status registry: every adapter capability carries `live | pending | unsupported`, surfaced in the founder console integration panel (6.1). The UI must never let a founder believe a pending capability is live. (architecture.md §5.2)
- [ ] D.3 Delivery-confirmation + fallback ladder for escalation prompts: glasses → push → web inbox → honest client deferral, each step requiring a positive ack before it counts as delivered. Silence is never a founder answer. (architecture.md §5.3; folds into 5.3/4.3)
- [ ] D.4 Retrieval bake-off on the seed knowledge set: plain text search vs pgvector, decision logged either way, before adopting pgvector (CLAUDE.md scopes it to where it actually helps). Folds into 5.2.
- [ ] D.5 Founder **availability mode** must carry a per-channel delivery capability, not just on/off — on iOS, "available" means an availability session is joined and prompts can arrive hands-free; otherwise delivery degrades a rung. (spike §1.3, §4; folds into 6.1)
- [ ] D.6 Escalation **expiry timer owned by the orchestrator**, independent of any adapter's liveness, so a dead or backgrounded adapter cannot stall an escalation past its deadline. (spike §4; folds into 5.3)
- [ ] D.7 Run spike experiments E1–E6 when Meta account + glasses arrive. **E1 (does audio need a DAT session?) is decisive** — a negative result removes the toolkit from the critical path entirely. Blocked on NEEDS-USER.md §3.
