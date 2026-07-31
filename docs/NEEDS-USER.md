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

_For the record on where the line is:_ a1mobile does have a live internal API that its own dashboard calls. I found it, I've recorded that it exists as intelligence in architecture.md, and **this codebase will not call it** — undocumented, auth-gated, and against both CLAUDE.md's integration rule and near-certainly their terms.

### 2. GitHub remote for PRs

`gh` is authenticated (account: `masterbrainy`) but creating a repo on your account is outward-facing, so I won't do it unilaterally. Tell me the name and visibility (e.g. private `cynthia`) or run `git remote add origin …` yourself. Until then: branch-per-item with local `--no-ff` merges, history kept PR-ready.

## Needs credentials/hardware you must provide (all have workarounds in place)

### 3. Meta developer account + toolkit access + the actual glasses

Needed to run the six experiments in docs/meta-wearable-spike.md §8 — above all **E1**, which determines whether the toolkit is on Cynthia's critical path at all. Required:

- A **Meta Managed Account** and Wearables Developer Center org, plus **separate iOS and Android project registrations** (one integration cannot span both) → Application ID + Client Token.
- The **Ray-Ban Meta Wayfarer Gen 2** on Meta AI app **V272+** and firmware **V127+** (DAT 0.8.0's documented requirement).
- **Xcode** (only Command Line Tools are installed) if we build the iOS companion app; DAT is native iOS/Android only — no React Native, no server SDK.

Note the real critical path is **approval, not hardware**: Meta runs a permission-justification review with **no published SLA, turnaround, or rejection criteria**. If it takes weeks, it dominates the schedule regardless of how the code is going. Worth starting the account application early even though nothing is blocked on it today.

### 3a. Two Meta findings you should see before planning a launch

Both from the 1.1 spike, both product-level rather than technical:

- **iOS cannot ship publicly at all right now.** Meta states publishing a DAT app to the App Store "will lead to App Store rejection due to Apple's MFi program and privacy manifest requirements," with no timeline given. Android Play Store status is simply undocumented. Distribution today is Developer Mode plus invite-only release channels where every tester needs a Meta account. Fine for a founder-only MVP; it caps anything beyond that at "internal pilot."
- **Hands-free prompting works differently per platform.** The PRD's "the founder should not need to open a phone" holds on Android via a fully documented path. On iOS it does not: silent push is throttled and non-guaranteed, and activating a nonmixable audio session from the background is a documented error. The honest iOS shape is that **the founder opts into an availability session, after which prompts arrive hands-free** — which maps neatly onto the availability mode the PRD already specifies. **Which platform is the founder's phone?** If it's iPhone and cold hands-free delivery is non-negotiable, say so and I'll scope experiment E5 (PushToTalk) rather than assuming the availability-session shape is acceptable.

### 4. Docker (or another container runtime) — blocks Phase 3 only

`supabase start` needs one and none is installed. Homebrew is present, so `brew install colima docker` or Docker Desktop/OrbStack would do it. Say the word and I'll install colima (reversible, no cost); I'm not installing multi-gigabyte system tooling on your machine unasked. Phases 1 and 2 (spike, state machine, domain logic, policy gates) need none of it, so this doesn't block anything for a while.

### 5. Hosted Supabase project — not needed yet

Local dev runs the full stack for free. When you want a deployed instance: create a project at supabase.com and give me the URL + publishable key. The secret key stays in server env only and should never be pasted into chat.

## Resolved

(none yet)
