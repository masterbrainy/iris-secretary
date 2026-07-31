# IRIS — MVP PRODUCT REQUIREMENTS DOCUMENT

Build prompt for Claude Fable 5

## ROLE

Act as the lead product engineer for Iris, a live AI executive secretary. Build a working MVP, not a presentation or a collection of mock screens. The code must integrate a1mobile, Supabase, and Ray-Ban Meta Wayfarer (Gen 2) glasses. Where production credentials or documented capabilities are unavailable, preserve the integration boundary and supply a deterministic simulator. Do not invent undocumented provider endpoints or bypass platform restrictions.

## PRODUCT GOAL

Iris receives the founder's business calls and messages through a1mobile. It answers routine requests from an approved knowledge base and approved tools. If the answer requires missing information or founder judgment, Iris keeps ownership of the client conversation, briefly places the client on hold, asks the founder through the Meta glasses, receives a short verbal response, and immediately relays that answer to the client. The founder should not need to open a phone or join the full call.

After each interaction, Iris creates a concise summary and turns any new founder answer into a proposed knowledge-base entry. Reusing that entry in future conversations should reduce repeated escalations.

## PRIMARY EXPERIENCE

1. A client calls or texts the founder's a1mobile business number.
2. Iris identifies the caller when possible and determines the caller's intent.
3. Iris searches the approved knowledge base and may use allow-listed tools such as scheduling.
4. If the request is unclear, Iris asks one focused clarification question.
5. If Iris has a supported, policy-safe answer, it responds directly.
6. If confidence is low or human judgment is required, Iris says a short hold phrase such as, "Let me check with my boss."
7. Iris sends the founder an escalation packet through the Ray-Ban Meta Wayfarer Gen 2 integration. The packet contains the caller, organization, relationship status, exact question, short context, priority reasons, and allowed actions.
8. The founder can answer verbally, decline, defer, or accept a direct handoff.
9. If the founder answers, Iris policy-checks the response and relays it to the client in the active conversation.
10. If the founder is unavailable, Iris returns to the client, captures a message, creates a follow-up, and gives an honest next step.
11. Iris saves the transcript, outcome, commitments, summary, audit timeline, and a proposed knowledge entry.

## MVP SCOPE

The MVP must support inbound calls, inbound and outbound SMS, approved knowledge retrieval, one clarification attempt, live founder escalation, response relay, founder-unavailable deferral, scheduling or follow-up creation, summaries, knowledge proposals, and an audit timeline. Autonomous negotiation, purchases, refunds, commitments, professional advice, and security-sensitive changes are out of scope and must escalate.

## REQUIRED INTEGRATION: A1MOBILE

a1mobile is the system of entry for the business phone number, calls, messages, contact context, and call routing.

Create an A1MobileAdapter with typed interfaces for inbound call/SMS events, verified webhooks, call and message metadata, transcripts or audio references when available, SMS replies, Iris's voice response, hold behavior, explicit call transfer, clean termination, and duplicate or out-of-order event handling.

Use only official a1mobile APIs, webhooks, SDKs, or supported integrations. First inspect the credentials and documentation supplied in the project. If a required capability is not documented or exposed, do not guess an endpoint. Implement the production adapter contract, mark the capability as pending, and provide an A1MobileSimulator that emits the same domain events for local development and automated tests.

Every inbound event needs verification where supported, idempotency, a trace ID, and a raw-event reference. Duplicate events must not duplicate messages, transfers, bookings, or follow-ups.

## REQUIRED INTEGRATION: SUPABASE

Use Supabase as the application backend:

- Supabase Auth for founder and admin authentication;
- Postgres for durable domain data;
- Row Level Security for organization isolation;
- Realtime for founder escalation notifications and status changes;
- Storage for permitted audio files or attachments;
- pgvector only where semantic retrieval improves knowledge search.

Create migrations and seed data for organizations, users, contacts, relationships, conversations, messages, escalations, founder_responses, knowledge_items, knowledge_versions, knowledge_proposals, tool_runs, follow_ups, and audit_events. Preserve provider event IDs, knowledge source references, state, scope, sensitivity, idempotency keys, and timestamps.

All tenant-owned tables must enforce organization_id through Row Level Security. Service-role credentials must remain server-side. Never expose secrets in the client, prompts, transcripts, or logs.

## REQUIRED INTEGRATION: RAY-BAN META WAYFARER GEN 2

Create a MetaWearableAdapter using the currently available official Meta Wearables Device Access Toolkit and the companion mobile application where required. The product must target Ray-Ban Meta Wayfarer (Gen 2), not the display glasses.

The desired glasses flow is: Iris speaks the caller and question; the founder answers, defers, declines, or requests the call; the response returns with its escalation ID; Iris relays it to the client.

Begin with a time-boxed spike. Verify device authentication, background delivery, audio playback, voice capture, latency, offline behavior, phone dependency, permissions, and review requirements. Record results in docs/meta-wearable-spike.md.

Do not assume the glasses support arbitrary background audio, microphone streaming, or custom wake words. If the official toolkit cannot support the full flow, keep the same MetaWearableAdapter contract and use the closest compliant interaction through the companion mobile app. A founder web inbox and mobile push flow must always exist as fallbacks.

## SYSTEM DESIGN

Use one conversation orchestrator with explicit policies and a deterministic state machine. Logical modules may include intake, retrieval, resolution, escalation, relay, and knowledge curation, but do not deploy a swarm of independent agents for the MVP.

Required states:

```
RINGING
ACTIVE
CLARIFYING
RESOLVING
ESCALATION_PENDING
FOUNDER_PROMPTED
FOUNDER_RESPONDED
RELAYING
RESOLVED
DEFERRED
HANDOFF
FAILED
ENDED
```

Reject invalid transitions and save every transition as an audit event.

Answer directly only when the source is approved, the knowledge scope matches the caller, confidence is above the configured threshold, and no sensitive policy is triggered. Ask no more than one clarification question. Founder timeout must produce a deferred response, never a fabricated answer. Direct handoff requires explicit founder acceptance.

The escalation packet must contain escalation_id, conversation_id, caller and organization, relationship status, priority with readable reasons, intent, verbatim question, context of no more than 40 words, optional recommended answer, allowed actions, and expiration.

## KNOWLEDGE BEHAVIOR

Treat founder responses as knowledge proposals, not automatically trusted facts. Each proposal must contain an atomic answer, title, scope, source conversation, timestamp, sensitivity, risk, confidence, and contradiction status.

Default to founder approval before publishing. Allow automatic publication only for explicitly configured low-risk categories. Customer-specific information must remain scoped to that contact or organization. Contradictory information must create a review item instead of silently overwriting approved knowledge. Every generated answer must retain the IDs of the knowledge sources it used.

## PRIORITY-CALL BEHAVIOR

Priority must be explainable. Use configured VIPs, relationship history, active deals, recognized organizations, intent, and urgency. Never mark a caller low priority only because they are unknown. Direct handoff still requires founder acceptance.

## MINIMUM USER INTERFACES

Build a founder console with a live escalation inbox; answer, defer, decline, and take-call controls; conversation history; audit timeline; contact context; knowledge review; availability mode; and integration status.

Build a client simulator that can run the full experience locally without paid services or hardware. It must display the current conversation state and allow simulated a1mobile and Meta glasses events.

## SECURITY AND FAILURE HANDLING

Provide configurable recording/transcription disclosure without claiming universal legal compliance. Minimize audio storage and separate retention for recordings, transcripts, summaries, knowledge, and audits. Redact secrets and unnecessary personal data. Confirm critical names, dates, prices, and commitments when transcription is uncertain. All side effects need typed inputs, authorization, timeouts, and idempotency.

If a1mobile, the AI service, Supabase Realtime, or the glasses integration fails, Iris must return to a safe state, capture callback information, create a follow-up when possible, and alert the founder or operator. The client must never be left in unexplained silence.

## SUCCESS TARGETS

- Iris acknowledges a connected client within 1.5 seconds as a target.
- The founder prompt is created within 3 seconds of the escalation decision as a target.
- A submitted founder answer is relayed within 1 second as a target.
- Routine seeded questions are completed without founder involvement.
- Sensitive or unsupported questions always escalate or defer.
- Founder timeout creates exactly one follow-up.
- Duplicate provider events never duplicate side effects.
- Approving a captured answer allows the next matching request to resolve without escalation.
- The full conversation timeline shows messages, states, sources, tool calls, escalation, founder action, and outcome.

## IMPLEMENTATION INSTRUCTIONS

1. Inspect the repository, credentials, and official provider docs before choosing endpoints or SDK methods.
2. Record assumptions and provider limitations in docs/architecture.md.
3. Use a TypeScript monorepo unless the repository requires another stack. Suggested structure: apps/web, apps/api, packages/domain, packages/adapters, supabase/migrations, tests/e2e, and docs.
4. Implement the state machine and tests before production channels.
5. Implement Supabase migrations, RLS, seed data, and generated types.
6. Implement A1MobileAdapter, MetaWearableAdapter, and simulators.
7. Build the client simulator, founder inbox, knowledge review, and timeline.
8. Test direct answer, clarification, live relay, timeout, knowledge reuse, sensitive escalation, duplicate webhook, and provider outage.
9. Add production provider code only where official documentation and credentials support it.
10. Run formatting, type checking, unit, integration, and end-to-end tests. Fix failures before handoff.

## DELIVERABLES

Provide runnable source code, SQL migrations, seed data, .env.example without secrets, setup instructions, architecture notes, a1mobile integration notes, Meta wearable spike results, automated tests, and a demo script.

The demo must show three consecutive scenarios:

1. A routine a1mobile call is answered from approved knowledge.
2. A hard question is escalated to the founder, answered through the Meta adapter, and relayed to the client.
3. The captured answer is approved in the founder console, and the same question is then answered without escalation.

Do not stop after scaffolding, pseudocode, or UI mockups. Complete the local vertical slice even if production a1mobile or glasses access must remain behind simulators.
