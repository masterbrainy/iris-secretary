# Architecture Notes

Living record of what actually exists, what doesn't, and every assumption or provider limitation the design depends on. Per CLAUDE.md: assumptions and provider limitations get recorded here as work proceeds. Anything stated here as fact carries a source; anything inferred is labelled INFERENCE.

Last updated: 2026-07-31 (bootstrap pass).

---

## 1. What is actually in this repo

Inventory taken 2026-07-31, before any code was written.

| Thing                                       | Status                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Source code                                 | **None.** Repo contained only `CLAUDE.md` and `docs/PRD.md`.                                        |
| Credentials of any kind                     | **None.** No `.env`, `.env.example`, `*.pem`, `*.key`, or `credentials*` file anywhere in the tree. |
| a1mobile SDK, docs, or API keys             | **None.**                                                                                           |
| Supabase project ref, URL, or keys          | **None.**                                                                                           |
| Meta developer credentials / Application ID | **None.**                                                                                           |
| Git                                         | Was not a repo. Initialised locally on `main` during bootstrap; no remote configured.               |

Local toolchain observed on the dev machine:

| Tool                       | Status                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Node                       | v22.15.0 ✅                                                                             |
| npm                        | 10.9.2 ✅                                                                               |
| corepack                   | 0.32.0 ✅ (pnpm available through it)                                                   |
| pnpm                       | not installed standalone (corepack will provide)                                        |
| Homebrew                   | 6.0.13 ✅                                                                               |
| Supabase CLI               | **not installed** — will be pinned as a repo devDependency                              |
| Docker / container runtime | **not installed** — blocks `supabase start` (Phase 3), blocks nothing before it         |
| Xcode                      | **not installed** (Command Line Tools only) — blocks any native iOS companion-app build |
| GitHub CLI                 | authenticated as `masterbrainy`; no repo created (see NEEDS-USER.md)                    |

**Consequence:** every provider capability in this codebase starts life as `pending` with a simulator behind it. That is not a shortcut — it is the only honest state given the inventory above, and it is exactly what CLAUDE.md prescribes.

---

## 2. a1mobile — the significant finding

### 2.1 There is no public a1mobile developer API

Researched 2026-07-31 against the live web, then independently re-verified by a second adversarial pass. Findings:

- **a1mobile ( a1mobile.com; a1mobile.ai 307-redirects to it ) is a US seed-stage "AI-native carrier"** selling texts, calls, 5G data and "AI reception built-in" at $99/mo, with an AI receptionist that "Answers, schedules, and follows up." Source: https://www.a1mobile.com/ and https://www.a1mobile.com/announcement ($11.5M seed led by General Catalyst).
- **Its entire sitemap is four pages** — `/`, `/legal/terms`, `/legal/privacy`, `/help`. No developer, docs, or API page. Source: https://www.a1mobile.com/sitemap.xml
- **The Terms of Service contain zero occurrences of the word "API."** Source: https://www.a1mobile.com/legal/terms
- **No developer subdomain exists.** DNS returns no records for `docs.`, `api.`, `developer.`, `developers.` on `a1mobile.ai`, nor `docs.`, `developer.`, `developers.`, `portal.`, `status.` on `a1mobile.com`.
- **No machine-readable contract is published.** A first-party backend is live at `api.a1mobile.com` (`GET /health` → `{"status":"ok",...}`), but `/docs`, `/redoc`, `/swagger`, `/openapi.json`, `/api-docs` all return `404 {"detail":"Not Found"}`.
- **No SDK, npm package, GitHub repo, Postman collection, or third-party API directory listing** for an a1mobile telephony API exists. Third-party product listings enumerate its features and explicitly list no API/webhook/SDK capability.

**Two unrelated namesakes** exist and must not be confused with the target: NTT East's Japanese "A1mobile" softphone app (`com.ipmp.a1mobile`), and A1 Telekom Austria / A1 Group (an MNO; wholesale SMPP/HTTP messaging, no self-serve public CPaaS voice portal). Pin the identity as **a1mobile.com (US, General Catalyst-backed)** in any future search or procurement.

### 2.2 a1mobile is a competitor-shaped product, not a substrate

This deserves the founder's attention before any commercial dependency is assumed. a1mobile's own pitch — an AI receptionist bound to a business number that answers, schedules and follows up — **is the same product surface as Iris's routine-answer path**. Building Iris's entry point on a1mobile means routing the core value proposition through a vendor selling the same thing. Whether the founder has an actual account/relationship with a1mobile, or whether "a1mobile" in the PRD is an aspiration, is an open question logged in NEEDS-USER.md.

### 2.3 The undocumented internal API is intelligence, not an integration target

The research pass discovered — from a1mobile's own publicly-served dashboard JavaScript bundles — a private, auth-gated REST surface under `api.a1mobile.com/api/v1/` (calls, voice/assistant, message, reservations, organizations, users). It also found the dashboard bundles `@twilio/voice-sdk` with `Twilio.Device`/`Twilio.Call` and a `/api/v1/calls/token` endpoint, i.e. the textbook Twilio access-token pattern, which suggests (INFERENCE — only the browser leg is evidenced) that at least a1mobile's web dialer runs on Twilio Programmable Voice.

**Standing decision: this codebase will not call those endpoints.** They are undocumented, auth-gated, carry no contractual stability, and using them would violate both CLAUDE.md's rule against undocumented provider endpoints and, near-certainly, a1mobile's terms. They are recorded here as evidence about what the company's product does — nothing more. No endpoint list is reproduced in this repo's source.

_Process note, recorded for honesty:_ the research agent, in establishing the above, issued unauthenticated HTTP requests to `api.a1mobile.com` (which returned 401/404/405 auth challenges). That went further than probing public documentation and will not be repeated; all further a1mobile questions get answered by asking a1mobile, not by probing them.

### 2.4 Consequence for the A1MobileAdapter

The adapter contract will be specified against the **union of two fully, publicly documented CPaaS lifecycles** — Twilio Programmable Voice (webhook → TwiML, status callbacks) and Telnyx Call Control (webhook in, REST command out) — because that is the shape any telephony provider, a1mobile included, would have to satisfy. Referencing public vendor documentation to design our own interface is not the same as inventing an a1mobile endpoint; **no a1mobile endpoint is asserted anywhere in the contract.** Every a1mobile capability is marked `pending` and backed by `A1MobileSimulator`.

Design consequences already settled (see DECISIONS-LOG.md):

- **Model the domain on the async command/webhook shape (Telnyx-style), not the synchronous TwiML request-response shape.** Iris's core flow — hold the client, ask the founder through the glasses, return with an answer — is inherently asynchronous and multi-turn. If TwiML's request-response shape leaks into the domain layer, the hold-and-relay flow fights the abstraction. A TwiML-shaped adapter can translate downward (`hold` → `<Enqueue>`, `resume` → REST update / `<Leave>`).
- **Webhook verification is adapter-level and provider-specific** (Twilio: HMAC-SHA1 over URL + sorted params in `X-Twilio-Signature`; Telnyx: Ed25519 over timestamp+body). The contract exposes `verifyWebhook(rawBody, headers) -> Result<VerifiedEvent>`; the a1mobile implementation is `pending`; the simulator emits a deterministic signature so the dedupe/idempotency code path is genuinely exercised in tests.
- **Idempotency keys derive from the provider event ID, not payload content** (Twilio `CallSid`/`MessageSid`, Telnyx event `id`). Since a1mobile's field name is unknown, the envelope carries `providerEventId` as an opaque string extracted by a per-provider mapper, so a provider swap doesn't invalidate stored keys.

---

## 3. Meta Wearables Device Access Toolkit (Ray-Ban Meta Gen 2)

Desk research 2026-07-31, adversarially verified. The full spike document (roadmap 1.1) will carry the capability matrix and adapter contract; this section records the load-bearing constraints the architecture must respect.

### 3.1 What is confirmed

- **The toolkit is real and official**: "Meta Wearables Device Access Toolkit" (DAT), at https://wearables.developer.meta.com. Still **Developer Preview, not GA** — both official GitHub READMEs state "The Wearables Device Access Toolkit is in developer preview." Current SDK **0.8.0, dated 2026-06-25**.
- **Ray-Ban Meta Gen 2 is supported.** The official FAQ lists "Ray-Ban Meta (Gen 1 and Gen 2), Ray-Ban Meta Display, Oakley Meta HSTN, Oakley Meta Vanguard." _Wayfarer_ is a frame style, not a separate support tier — support is at the Gen 2 product level. DAT 0.8.0 requires Meta AI app V272 and glasses firmware V127.
- **Native iOS and Android SDKs only.** iOS 15.2+/Xcode 14+ via SPM; Android 10+ via GitHub Packages (needs a `read:packages` token plus an Application ID from the Wearables Developer Center). **No React Native support is documented.** A community Flutter bridge exists but is third-party.
- **Audio rides standard Bluetooth profiles, not a proprietary pipe.** A2DP for playback (44.1/48 kHz stereo); HFP for bidirectional audio with beamformed mic capture at **8 kHz mono**. iOS uses `AVAudioSession` (`.playback`; `.playAndRecord` + `.allowBluetoothHFP` + an `AVAudioEngine` input tap), Android uses `AudioManager.setCommunicationDevice(TYPE_BLUETOOTH_SCO)`.
- **A2DP and HFP are mutually exclusive.** Verbatim from the docs: activating HFP "switches the glasses away from A2DP, and audio output quality drops to 8 kHz mono for the duration of the session." iOS sample code waits ~2 seconds for the route to stabilise.
- **Session model**: one-time registration by deep-link into the Meta AI app; camera permission via a Meta AI deeplink, mic permission via normal platform dialogs; revocable from Meta AI's "App Connections." **Only one DAT session per device at a time.** States STARTED/PAUSED/STOPPED. **Closing the hinges forces STOPPED, and reopening does not restart the session** — the app must start a new one.
- **iOS background modes are officially documented** (this corrects an initial research claim that they weren't): the official iOS integration guide specifies `UIBackgroundModes` with `bluetooth-peripheral` and `external-accessory`. Changelogs confirm streaming _continues_ in background from v0.2.1, with HEVC background streaming from v0.5.0. The Android guide contains **no** foreground-service guidance.
- **A Mock Device Kit ships with the SDK** for testing without hardware (simulate device state, permissions, media streaming). Does not cover display glasses.

### 3.2 Hard limits the product must design around

1. **No cloud-to-glasses push.** DAT is exclusively a mobile SDK; there is no server-side API. Any escalation must travel: server → push/socket → companion phone app → Bluetooth → glasses.
2. **Total phone dependency.** The glasses pair to the phone; the Meta AI app brokers registration and permissions; sessions stop when Meta-AI-app-to-glasses connectivity drops.
3. **No Meta AI / "Hey Meta" access, no custom wake word.** Verbatim: accessing Meta AI capabilities "including voice commands, isn't part of our initial developer preview." Voice invocation is listed as still under development. **The founder cannot say "Hey Iris" to the glasses.** Interaction is app-initiated with a short prompted reply window — never ambient listening.
4. **Cannot ship publicly yet.** "Publishing is currently not available during the Developer Preview phase"; only select partners can publish, GA "anticipated in 2026." Distribution today is Developer Mode (enable by tapping the Meta AI app version number five times) plus invite-only release channels for up to 100 testers. Adequate for a single-founder MVP; not a public-launch path.
5. **No documented latency figures at all.** Meta publishes none. End-to-end latency will be dominated by push delivery + TTS + the HFP route switch — measurable only with real hardware.
6. **Pre-1.0 SDK with monthly breaking releases**, coupled to specific Meta AI app and firmware versions. Pin versions; expect churn.

### 3.3 The most important open risk

**Background _initiation_ is unproven, and on iOS it is close to disproven.** Docs and changelogs establish that streams _continue_ when the app is backgrounded; nothing documents waking a backgrounded app to _start_ audio. Deeper research (spike §1.3) found three independent iOS blockers — silent push is throttled and non-guaranteed, `AVAudioSession.ErrorCode.cannotInterruptOthers` is defined as exactly this failure for nonmixable sessions, and PushKit requires CallKit. Android by contrast has a complete documented path (high-priority FCM → foreground-service background-start exemption → `connectedDevice`/`mediaPlayback` → A2DP).

**Verdict: PENDING on Android, effectively UNSUPPORTED-as-designed on iOS** — iOS hands-free requires a pre-joined PushToTalk channel or a founder tap.

Mitigation, which the PRD already mandates: the founder web inbox and mobile push **always exist as fallbacks**, and the escalation flow requires an explicit delivery confirmation back to the server before it counts a prompt as delivered. If confirmation doesn't arrive, the flow degrades — it never assumes the founder heard anything.

### 3.4 Corrections and additions from the 1.1 spike

Full detail in [meta-wearable-spike.md](meta-wearable-spike.md). Load-bearing amendments to §3.1–3.2:

- **DAT exposes no audio API whatsoever** — no `play()`, no `startMicrophone()`, no audio type. Camera, display, and session management only. Meta's guidance is to use `AVAudioPlayer`/`AVSpeechSynthesizer`/`AudioManager`. Since Iris's escalation flow is **audio-only**, the glasses leg is a Bluetooth-headset problem, not a Meta-toolkit problem — the risk moves off the preview SDK onto platform audio policy.
- **Whether audio needs a DAT session at all is undocumented in both directions.** If it doesn't, DAT leaves Iris's critical path entirely (spike §7). Decisive experiment E1.
- **iOS cannot ship publicly at all today**: "Publishing to the App Store is not currently supported… App Store rejection due to Apple's MFi program and privacy manifest requirements." Android Play Store status is **undocumented** — mark unknown, don't assume. This arguably outranks the background question as a launch risk.
- **The real critical path is access, not hardware**: org registration, per-platform project registration, and a **Meta permission-justification review with no published SLA**. iOS and Android must be registered as separate applications; no dash in the iOS Bundle ID.
- **MockDeviceKit is substantial** — simulates registration, permissions, pairing, power, don/doff, fold, cap-touch, camera — and runs in CI with no hardware. **But it documents no audio path**, so the one capability Iris needs is likely hardware-only.
- Correction to §3.1: the docs say only "microphones"; the **"5-mic array" is hardware marketing, not a DAT spec**. Also, the FAQ's motion/orientation/GPS answer describes Web Apps on Display glasses, **not** DAT.
- No battery API, no wear-state read, and no transition reason on state change. Wear detection is a user setting the app **cannot read**, so "doffed" and "still worn" are indistinguishable when it's off.

### 3.5 Consequence for the MetaWearableAdapter

- The adapter's server-side contract terminates at the **companion app**, not at the glasses. Its domain events are identical whether they originate from real glasses, the companion app UI, the web inbox, or `MetaWearableSimulator`. That is what makes the simulator honest rather than a fake. Contract shape frozen in spike §5; typed package lands in roadmap 4.2.
- The native companion app is **out of scope for the TypeScript monorepo's vertical slice** and blocked anyway (no Meta account, no hardware, no Xcode). The vertical slice therefore proves the contract through the simulator and the web inbox; the glasses leg stays a typed, `pending`, contract-preserved capability.
- Whoever writes the native code later: the API reference **strips `async`/`throws`** from rendered signatures across all three modules. Sample apps are authoritative; compile against the SDK rather than generating from the reference.

---

## 4. Supabase

No blocking unknowns; the local stack is the standard CLI + Docker workflow. Decisions taken from current official docs:

- **CLI pinned as a repo devDependency** (Node 20+) so every developer and CI runs the same version via `npx`; Docker Desktop/OrbStack/colima is a hard prerequisite for `supabase start` and is **not currently installed** (see NEEDS-USER.md).
- **Migrations-first**: all schema in `supabase/migrations/`, `supabase db reset` as the canonical local rebuild, seeds split via `config.toml` `[db.seed] sql_paths`.
- **Multi-tenant RLS**: `organization_id` on every tenant-scoped table. Policies must wrap auth calls as `(select auth.uid())` for per-statement caching, add `to authenticated`, and index `organization_id` — these are documented, measured performance requirements, not stylistic preferences. Membership lookups go through a `security definer` function in a private schema (preferred over JWT `app_metadata` claims, because claims go stale; the docs say plainly that "a JWT is not always fresh").
- **Key hygiene**: use the new `sb_publishable_` / `sb_secret_` keys — legacy `anon`/`service_role` JWT keys are deprecated by end of 2026. The secret key bypasses RLS entirely and may appear only in server-side packages, never in any client bundle.
- **Data API grants**: new public-schema tables stop being auto-exposed to the Data API on 2026-10-30. Explicit `GRANT`s go into the migration template now to avoid a production surprise.
- **RLS testing** via pgTAP (`supabase test db`), optionally with basejump's `supabase_test_helpers` for `tests.create_supabase_user` / `tests.authenticate_as`.
- **Realtime**: `postgres_changes` is fine at MVP scale but is authorization-checked per subscriber and is discouraged beyond ~3,000 concurrent subscribers. The scalable documented pattern is "broadcast from database": per-organization **private** channels (`config: { private: true }`) with RLS policies on `realtime.messages` keyed on `realtime.topic()`, fed by `realtime.broadcast_changes()` triggers. Channel topics will be shaped `org:<organization_id>` so realtime authorization reuses the same membership tables as row RLS. Note: as of July 2026 the `realtime` schema is DDL-locked — policies go on `realtime.messages`, no custom objects in that schema.
- **pgvector**: enable in an early migration (`create extension vector with schema extensions`), HNSW indexes with an operator class matching the query operator, similarity search exposed as SQL functions called via `.rpc()` (PostgREST cannot express vector operators). **Only if** plain search proves insufficient on the seed set — CLAUDE.md scopes pgvector to "where semantic retrieval actually improves knowledge search," so that comparison gets made and logged rather than assumed.
- **supabase-js v2** (2.111.0 current stable). A `3.0.0-next` prerelease exists; do not adopt it. TypeScript ≥ 5.0 from the start.

Unresolved minor discrepancy to settle when writing Realtime code: the authorization guide shows `config: { private: true }` while the broadcast guide shows `config: { broadcast: { private: true } }`. Verify against the supabase-js reference at implementation time.

---

## 5. Standing architectural consequences

1. **The MVP's provable vertical slice is: orchestrator + Supabase + web console + client simulator + two adapter simulators.** Both external providers are unavailable for genuine integration — one publishes no API at all, the other is a preview-stage mobile-only SDK requiring hardware and an approved developer account. This is the honest maximum, and per CLAUDE.md it is correct progress, not a shortfall.
2. **Every capability gets an explicit status of `live` / `pending` / `unsupported`,** surfaced in the founder console's integration status panel. The UI must never let a founder believe a pending capability is live.
3. **The escalation flow requires positive delivery confirmation.** No prompt counts as delivered without an ack event; absent an ack, the flow degrades to the next fallback (push → web inbox) and ultimately to an honest client deferral. There is no path in which silence is interpreted as the founder having heard the question.
