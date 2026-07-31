# NEEDS USER

Only blockers Claude cannot clear alone: credentials, accounts, spending, hardware, or judgment calls with no defensible default. Everything here has a workaround in place (simulator, deferral, or a later phase) — **nothing below is currently stalling the roadmap.**

## Needs a real decision from you

### 1. a1mobile appears to be a competitor, not a platform — is this the right entry point?

**This is the most important item on the page.** Research on 2026-07-31 (adversarially re-verified, details in docs/architecture.md §2) found:

- a1mobile (a1mobile.com; a1mobile.ai redirects there) is a US seed-stage "AI-native carrier" — $11.5M seed led by General Catalyst — selling a business number with an **AI receptionist that "answers, schedules, and follows up"** for $99/mo. That is the same product surface as Cynthia's routine-answer path.
- It publishes **no developer API whatsoever**: no docs site, no developer subdomain, no SDK, no npm package, no OpenAPI spec, zero occurrences of "API" in its Terms of Service, and a four-page sitemap. Its own product is the integration.

So two questions, and I've kept building either way:

- **(a) Do you have an actual account or relationship with a1mobile** — is there a partner/beta API, or a contact who could confirm one? Nothing public suggests one exists; the only listed contact is `support@a1mobile.com`. If you want, I can draft the email asking whether an API/webhook program, sandbox, or partner integration exists and what the auth and webhook-signing model is. I won't send it — that's outward-facing.
- **(b) If no a1mobile API materialises, do you want a real telephony provider in the MVP?** Twilio Programmable Voice and Telnyx Call Control are both fully documented, have free trial numbers, and support every verb the PRD requires (answer, say, gather, hold, transfer, terminate, SMS, status callbacks). Wiring one would make the vertical slice genuinely live instead of simulator-only. **This is a scope and spending decision, so I won't take it unilaterally** — CLAUDE.md names a1mobile as the entry point, and adding a provider changes the provider story. Default if you say nothing: the A1MobileAdapter contract stays typed-and-pending with `A1MobileSimulator` behind it, per CLAUDE.md.

*For the record on where the line is:* a1mobile does have a live internal API that its own dashboard calls. I found it, I've recorded that it exists as intelligence in architecture.md, and **this codebase will not call it** — undocumented, auth-gated, and against both CLAUDE.md's integration rule and near-certainly their terms.

### 2. GitHub remote for PRs

`gh` is authenticated (account: `masterbrainy`) but creating a repo on your account is outward-facing, so I won't do it unilaterally. Tell me the name and visibility (e.g. private `cynthia`) or run `git remote add origin …` yourself. Until then: branch-per-item with local `--no-ff` merges, history kept PR-ready.

## Needs credentials/hardware you must provide (all have workarounds in place)

### 3. Meta developer account + toolkit access + the actual glasses

Needed to verify the device-dependent half of the spike: real latency, whether a backgrounded app can be *woken* to start audio to the glasses (the single biggest unresolved risk — see architecture.md §3.3), mic capture quality, and permission-prompt behaviour. Specifically required:

- A **Meta Managed Account** and Wearables Developer Center org/project → an Application ID (developers must be in an AI-glasses-supported country).
- The **Ray-Ban Meta Wayfarer Gen 2** on Meta AI app **V272+** and firmware **V127+** (DAT 0.8.0's documented requirement).
- **Xcode** (only Command Line Tools are installed) if we build the iOS companion app; DAT is native iOS/Android only — there is no React Native support and no server SDK.

Without these, the spike is desk-only and the glasses leg stays typed-and-pending behind `MetaWearableSimulator`. Note that even *with* them, public shipping isn't possible yet — the toolkit is Developer Preview and publishing is select-partners-only.

### 4. Docker (or another container runtime) — blocks Phase 3 only

`supabase start` needs one and none is installed. Homebrew is present, so `brew install colima docker` or Docker Desktop/OrbStack would do it. Say the word and I'll install colima (reversible, no cost); I'm not installing multi-gigabyte system tooling on your machine unasked. Phases 1 and 2 (spike, state machine, domain logic, policy gates) need none of it, so this doesn't block anything for a while.

### 5. Hosted Supabase project — not needed yet

Local dev runs the full stack for free. When you want a deployed instance: create a project at supabase.com and give me the URL + publishable key. The secret key stays in server env only and should never be pasted into chat.

## Resolved

(none yet)
