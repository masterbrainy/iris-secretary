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
- [x] 1.2 **a1mobile capability audit** → recorded in architecture.md §2. Finding: **no public developer API exists**; a1mobile is a competitor-shaped AI-receptionist carrier, not a CPaaS. No credentials in repo. Every A1MobileAdapter capability is therefore `pending`, backed by the simulator. Contract *freezing* happens in 4.1 against the Twilio/Telnyx public reference shape. Open commercial question escalated in NEEDS-USER.md §1.

## Phase 2 — Foundation (no provider code yet)

- [ ] 2.1 Monorepo scaffold: pnpm workspaces + TypeScript strict; apps/web, apps/api, packages/domain, packages/adapters, supabase/, tests/e2e, docs. Format (prettier), lint (eslint), test runner (vitest), typecheck scripts wired at root. CI-runnable via one command.
- [ ] 2.2 **packages/domain: conversation state machine.** All 13 states (RINGING…ENDED), explicit transition table, invalid transitions rejected, every transition emits a typed audit event. Pure, deterministic, no I/O. Unit tests for every legal and a representative set of illegal transitions. Break the code once to prove the tests fail.
- [ ] 2.3 packages/domain: inbound-event envelope — trace ID, provider event ID, raw-event reference, idempotency key derivation. Dedupe semantics unit-tested (duplicate + out-of-order delivery).
- [ ] 2.4 packages/domain: policy gates — direct-answer preconditions (approved source, scope match, confidence threshold, no sensitive trigger), one-clarification limit, sensitive-category escalation list (negotiation, purchases, refunds, commitments, professional advice, security-sensitive changes), founder-timeout → exactly one follow-up, handoff-requires-explicit-acceptance. Unit tests per gate.
- [ ] 2.5 Escalation packet builder: escalation_id, conversation_id, caller/org, relationship status, priority + readable reasons, intent, verbatim question, ≤40-word context, optional recommended answer, allowed actions, expiration. Priority explainability from configured signals; unknown caller ≠ low priority. Unit tests.

## Phase 3 — Data layer

- [ ] 3.1 Supabase local stack (CLI + Docker), migrations for all 14 core tables (organizations, users, contacts, relationships, conversations, messages, escalations, founder_responses, knowledge_items, knowledge_versions, knowledge_proposals, tool_runs, follow_ups, audit_events) with provider event IDs, knowledge source refs, state, scope, sensitivity, idempotency keys, timestamps.
- [ ] 3.2 RLS on every tenant-owned table via organization_id — no exceptions. RLS tests that prove cross-org reads/writes fail. Service-role usage confined to apps/api server code.
- [ ] 3.3 Seed data: one org, founder user, contacts (VIP + unknown), approved knowledge items covering the "routine questions" demo set, generated TypeScript types.

## Phase 4 — Adapters + simulators

- [ ] 4.1 A1MobileAdapter typed contract (from 1.2) + **A1MobileSimulator**: deterministic, emits the same domain events (inbound call, inbound/outbound SMS, transcript segments, hold, transfer, terminate, status callbacks), supports scripted duplicate/out-of-order delivery for tests.
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
