# CLAUDE.md

Project instructions for Claude Code. Read this before making changes. Full requirements, walkthrough, success targets, and demo script: docs/PRD.md.

## Product

Cynthia is a live AI executive secretary. It receives a founder's business calls/texts through a1mobile, answers routine requests from an approved knowledge base and allow-listed tools, and — when it can't safely answer — keeps the client on hold, asks the founder a focused question through the Ray-Ban Meta Wayfarer (Gen 2) glasses, relays the founder's short verbal answer back to the client, and turns that answer into a proposed knowledge entry so the same question doesn't escalate next time.

Build a working MVP, not mock screens. Where production credentials or documented provider capabilities are unavailable, preserve the integration contract and back it with a deterministic simulator — never fake the feature.

## Stack

* TypeScript monorepo unless the repo requires otherwise: apps/web, apps/api, packages/domain, packages/adapters, supabase/migrations, tests/e2e, docs
* Supabase: Auth, Postgres, Row Level Security, Realtime, Storage, pgvector (only where semantic retrieval actually improves knowledge search)
* a1mobile — phone/SMS entry point, via adapter + simulator
* Meta Wearables Device Access Toolkit — Ray-Ban Meta Wayfarer Gen 2 specifically, not the display glasses — via adapter + simulator

## The integration boundary is the load-bearing rule

* Never invent an undocumented provider endpoint or bypass a platform restriction. Inspect the actual credentials and docs present in the repo before choosing any SDK method or endpoint — don't guess.
* Where a capability isn't documented or available: implement the production adapter's typed contract, mark the capability pending, and back it with a simulator that emits the same domain events. Simulators exist so local dev and tests never depend on live provider access — not as a way to ship a feature that doesn't actually work.
* This governs the Meta glasses work specifically. Start with a time-boxed spike (device auth, background delivery, audio playback, voice capture, latency, offline behavior, phone dependency, permissions) and record it in docs/meta-wearable-spike.md before building the flow around it. If the toolkit can't support the full flow, keep the same adapter contract and degrade to the closest compliant interaction via the companion app — a founder web inbox and mobile push must always exist as fallbacks.

## Architecture invariants

Expensive to change later. Do not violate without raising it first.

* One orchestrator, one deterministic state machine. Intake, retrieval, resolution, escalation, relay, and knowledge curation are logical modules inside it — not a swarm of independent agents.
* States: RINGING, ACTIVE, CLARIFYING, RESOLVING, ESCALATION_PENDING, FOUNDER_PROMPTED, FOUNDER_RESPONDED, RELAYING, RESOLVED, DEFERRED, HANDOFF, FAILED, ENDED. Invalid transitions are rejected. Every transition is an audit event.
* Idempotency on every inbound provider event. Trace ID plus raw-event reference; a duplicate must never duplicate a message, transfer, booking, or follow-up.
* Founder timeout produces a deferred response, never a fabricated answer, and creates exactly one follow-up.
* Direct call handoff requires explicit founder acceptance — never inferred from silence or a generic reply.
* At most one clarification question before Cynthia must resolve, escalate, or defer.
* Any dependency failure (a1mobile, the AI service, Supabase Realtime, the glasses integration) returns Cynthia to a safe state, captures callback info, creates a follow-up where possible, and alerts the founder/operator. The client is never left in unexplained silence.

## Data (Supabase)

* RLS on every tenant-owned table via `organization_id` — no exceptions.
* Service-role credentials stay server-side; never in the client, a prompt, a transcript, or a log.
* Core tables: organizations, users, contacts, relationships, conversations, messages, escalations, founder_responses, knowledge_items, knowledge_versions, knowledge_proposals, tool_runs, follow_ups, audit_events. Preserve provider event IDs, knowledge source references, state, scope, sensitivity, idempotency keys, and timestamps.

## Knowledge behavior

* A founder's answer is a proposal, not an automatically trusted fact. Default to founder approval before publishing; auto-publish only for explicitly configured low-risk categories.
* Customer-specific information stays scoped to that contact/organization — it never becomes general knowledge.
* A contradiction creates a review item. It never silently overwrites approved knowledge.
* Every generated answer retains the IDs of the knowledge sources it used.

## Scope

In: inbound calls/SMS, approved knowledge retrieval, one clarification attempt, live founder escalation, response relay, founder-unavailable deferral, scheduling/follow-up creation, summaries, knowledge proposals, audit timeline.

Out — these always escalate, never execute autonomously: negotiation, purchases, refunds, commitments, professional advice, security-sensitive changes.

## Priority

Priority must be explainable from configured signals — VIP status, relationship history, active deals, recognized organizations, intent, urgency. An unknown caller is never low-priority only because they're unknown. Handoff still requires founder acceptance regardless of priority.

## Security

* Configurable recording/transcription disclosure. Never claim universal legal compliance — that's a jurisdiction-specific legal question, not an engineering default.
* Separate retention policy per data class: recordings, transcripts, summaries, knowledge, audits.
* Redact secrets and unnecessary personal data.
* Confirm critical names, dates, prices, and commitments when transcription confidence is low, rather than acting on a guess.
* Every side effect (booking, transfer, message send) needs a typed input, authorization, a timeout, and an idempotency key.

## Working agreements

* Inspect the repo's actual credentials and provider docs before writing any adapter code. Record assumptions and provider limitations in docs/architecture.md as you go.
* State machine and its tests exist before wiring any production channel.
* Before calling anything done, test: direct answer, clarification, live relay, founder timeout, knowledge reuse, sensitive escalation, duplicate webhook, provider outage.
* Format, typecheck, unit, integration, and e2e all pass before handoff.
* Work on branches and open PRs; do not commit directly to main.
