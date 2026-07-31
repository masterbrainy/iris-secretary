# Meta Wearables Spike — Ray-Ban Meta Wayfarer (Gen 2)

Roadmap item 1.1. Time-boxed spike required by CLAUDE.md before building the escalation flow around the glasses.

**Date:** 2026-07-31 · **SDK under review:** Device Access Toolkit (DAT) 0.8.0, released 2026-06-25 · **Status:** Developer Preview

## 0. What this spike is and is not

This is the **desk portion**. Every finding below comes from official Meta, Apple, and Android documentation, cross-checked by independent research passes and one adversarial critic pass. Claims carry sources.

**Nothing here was verified on hardware.** There is no Meta developer account, no Wearables Application ID, and no physical glasses available to this project (see NEEDS-USER.md §3). Where a question can only be answered by experiment, it is marked **UNVERIFIED** and appears in §8 with the experiment that would settle it. No capability is claimed to work on the strength of documentation alone.

**Spot-check performed.** The four claims this document leans on hardest were re-fetched directly from Meta's docs and confirmed verbatim: the "use `AVAudioPlayer`, `AVSpeechSynthesizer`, or any standard audio API" guidance, the A2DP/HFP mutual-exclusion sentence, the App Store rejection statement, and the _absence_ of any sentence making a DAT session a prerequisite for audio. One additional detail surfaced during that check and is recorded in §3.

---

---

## 1. The five findings that matter

### 1.1 DAT has no audio API at all

This is the single most important finding, and it reframes the whole spike.

The Device Access Toolkit exposes **camera, display, and device-session management — and nothing else**. There is no `play()`, no `startMicrophone()`, no audio stream type, no audio class anywhere in the SDK. Meta's own guidance is to use the platform's audio stack:

> "Use `AVAudioPlayer`, `AVSpeechSynthesizer`, or any standard audio API to play audio."
> — https://wearables.developer.meta.com/docs/develop/dat/microphones-and-speakers/

Audio to and from the glasses is **ordinary Bluetooth**: A2DP out, HFP bidirectional, driven by `AVAudioSession` on iOS and `AudioManager` on Android.

**Cynthia's escalation flow is audio-only.** It plays a short spoken question and captures a short spoken answer. It needs no camera, no display, no sensors. Therefore **the glasses leg of this product is a Bluetooth-headset problem, not a Meta-toolkit problem** — and the risk moves off Meta's preview-stage SDK and onto iOS/Android background-audio policy, which is far better documented.

### 1.2 Whether audio needs a DAT session at all is genuinely unknown

The docs never state, in either direction, whether a DAT `DeviceSession` must be started for A2DP playback or HFP capture to work. The only sentence linking the two is an ordering constraint explicitly scoped to _"When using HFP with a DAT camera stream."_ It does not say audio requires DAT; it does not say audio works without it.

This is **the highest-value experiment in §8**. If audio works with no session and no registration, then every DAT constraint — preview status, registration flow, permission review, session fragility, even the App Store blocker — **drops out of Cynthia's critical path entirely**, and the glasses become a paired Bluetooth headset that happens to be spectacles. That would be a large simplification. It cannot be assumed.

### 1.3 Hands-free server-initiated prompting: Android plausible, iOS effectively not

The PRD's premise is that the founder "should not need to open a phone." Whether that holds is a platform question, and the platforms differ sharply.

**iOS — the naive design is not permitted.** Three independent documented blockers:

1. **Silent push is not a dependable trigger.** Apple: the system "doesn't guarantee their delivery," and advises not to "send more than two or three per hour." Background pushes are low-priority, throttled, coalesced, and dropped after force-quit.
2. **Activating audio from the background is a documented error.** `AVAudioSession.ErrorCode.cannotInterruptOthers` is defined as "An attempt to make a nonmixable audio session active while the app was in the background." Apple documents the audio background mode as _continuation_ ("your app's audio continues when people switch to another app") — never as push-initiated start.
3. **PushKit/VoIP is closed.** "If you are unable to support CallKit in your app, you cannot use PushKit." Presenting a fake incoming call to obtain background audio is documented misuse and a predictable review rejection.

The one Apple mechanism whose official description matches what this product wants is **PushToTalk** — the only `UIBackgroundModes` value documented as "launches in response to a push notification and plays audible content in the background." But it is scoped to an already-joined channel: the user must have called `requestJoinChannel` first. So the honest iOS shape is **"the founder opts into an availability session, after which prompts arrive hands-free"** — not "works cold with no prior action." Entitlement approval for a non-walkie-talkie app is also unpublished and uncertain.

**Android — a complete, documented path exists.** High-priority FCM (which is documented to "wake a sleeping device") → the Android 12 background-foreground-service-start exemption for high-priority FCM → `startForeground` with `foregroundServiceType="connectedDevice"` (whose runtime prerequisite, `BLUETOOTH_CONNECT`, DAT already requires) and/or `mediaPlayback` → audio over A2DP. A second independent exemption exists for companion devices (`REQUEST_COMPANION_START_FOREGROUND_SERVICES_FROM_BACKGROUND`), which is the best hedge against FCM's documented deprioritization heuristic — Google may downgrade high-priority messages that don't produce user-facing notifications, and "silently play audio with no notification" is exactly that pattern.

**Verdict: PENDING on iOS, PLAUSIBLE-UNVERIFIED on Android.** Neither is CONFIRMED; no document describes the end-to-end flow and no device test has been run.

### 1.4 iOS cannot ship publicly at all today

> "Publishing to the App Store is not currently supported… it will lead to App Store rejection due to Apple's MFi program and privacy manifest requirements."

This is a launch-gating constraint that arguably outranks the background question, and Meta has published no timeline. Distribution today is invite-only release channels with per-app tester caps, every tester needing a Meta account, plus Developer Mode for personal devices. **Android Play Store status is undocumented** — not confirmed open, not confirmed blocked; it must be marked unknown rather than assumed.

For a single-founder MVP this is survivable (Developer Mode covers the founder's own glasses). For a product launch it caps the ceiling at "internal pilot."

### 1.5 The Mock Device Kit is far more capable than expected — but appears to have no audio

MockDeviceKit runs in CI on plain simulators/emulators with no hardware, and simulates **registration, permission requests, pairing, power on/off, don/doff, fold/unfold, cap-touch tap and tap-and-hold, camera streaming, and photo capture**.

That shrinks the "cannot test without hardware" list dramatically for DAT-shaped work: the entire session state machine, the registration flow, and the permission-denied path are all CI-testable today.

**But the mock documentation describes only `device.services.camera`.** No audio path is mentioned. Since Cynthia's flow is audio-only, the mock likely cannot exercise the one thing this product depends on — which compounds §1.2: the central unknown may not even be answerable in CI.

---

## 2. Capability matrix

Status values: **live** (documented and available to us today) · **pending** (documented but unverified, or blocked on access/hardware) · **unsupported** (documented as unavailable; degrade to a fallback).

### 2.1 Access & enablement — the real critical path

None of this is hardware. All of it gates touching a real device, and an adapter that compiles and passes mock tests still cannot run until a human at Meta approves.

| Item                                                  | Status          | Note                                                                                                                             |
| ----------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Meta Managed Account + Wearables Developer Center org | pending         | Not created. Region availability for the program is undocumented.                                                                |
| Project registration → Application ID + Client Token  | pending         | iOS and Android must be registered as **separate applications**; one integration cannot span both.                               |
| **Permission justification review by Meta**           | pending         | Documented as existing. **No SLA, turnaround, or rejection criteria published.** If this takes weeks, it dominates the schedule. |
| Developer Mode (tap Meta AI app version 5×)           | pending         | Covers the founder's own glasses without review. Adequate for MVP.                                                               |
| Release channels / tester distribution                | pending         | Invite-only, per-app caps, testers need Meta accounts.                                                                           |
| Public distribution — iOS                             | **unsupported** | App Store rejection (MFi + privacy manifest). No timeline.                                                                       |
| Public distribution — Android                         | pending         | **Undocumented.** Do not assume either way.                                                                                      |

### 2.2 Audio — everything Cynthia actually needs

| Capability                                    | Status                     | Evidence / caveat                                                                                                                                                                          |
| --------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Play spoken prompt to glasses speakers (A2DP) | pending                    | Documented as standard Bluetooth; 44.1/48 kHz stereo. Unverified on hardware.                                                                                                              |
| Capture founder's spoken reply (HFP mic)      | pending                    | 8 kHz mono, beamformed to isolate the wearer's voice. Adequate for speech recognition; pick an ASR that handles narrowband.                                                                |
| Simultaneous high-quality playback + capture  | **unsupported**            | Verbatim: activating HFP "switches the glasses away from A2DP, and audio output quality drops to 8 kHz mono for the duration of the session." Every prompt→reply turn pays a route switch. |
| Route-switch latency                          | pending                    | Meta's own sample sleeps `2 * NSEC_PER_SEC` for route stabilization. Budget ~2s per switch; measure for real.                                                                              |
| Audio without a DAT session                   | **UNVERIFIED — decisive**  | See §1.2 and experiment E1.                                                                                                                                                                |
| Audio via MockDeviceKit (CI)                  | **unsupported (probable)** | Mock docs cover only camera services. Means the audio layer is likely hardware-only.                                                                                                       |
| Any DAT audio API                             | **unsupported**            | None exists. Platform APIs only.                                                                                                                                                           |

### 2.3 Interaction model

| Capability                                 | Status                                                | Note                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| App-initiated spoken prompt                | pending                                               | The supported interaction shape.                                                                     |
| Custom wake word ("Hey Cynthia")           | **unsupported**                                       | Not offered. Meta AI / "Hey Meta" voice commands are explicitly out of the developer preview.        |
| Always-on / ambient listening              | **unsupported**                                       | Reply capture must be a short prompted window, never ambient.                                        |
| Server → glasses push                      | **unsupported**                                       | DAT is a mobile SDK. **There is no Meta server-side API of any kind.** Everything is phone-mediated. |
| Hands-free delivery to a backgrounded app  | pending (Android) / **unsupported as designed** (iOS) | See §1.3. iOS requires a pre-joined PushToTalk channel or a founder tap.                             |
| Cap-touch tap = pause, tap-and-hold = stop | live (documented)                                     | Device-initiated; the app cannot pause/resume programmatically — no such API in 0.8.                 |

### 2.4 Device state

| Capability                                                            | Status            | Note                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session state machine (idle→starting→started→paused→stopping→stopped) | pending           | CI-testable via MockDeviceKit once access exists.                                                                                                                                                                   |
| Battery level read                                                    | **unsupported**   | No API. Battery surfaces only as terminal error cases.                                                                                                                                                              |
| Wear/donned state read                                                | **unsupported**   | No API on real devices (mock-only). Worse: doffing ends the session _only if wear detection is enabled_, and that setting is **not readable** — "doffed with detection off" is indistinguishable from "still worn." |
| Transition reason on state change                                     | **unsupported**   | Docs state explicitly that `DeviceSessionState` carries no reason.                                                                                                                                                  |
| Hinge close → forced stop                                             | live (documented) | Reopening does **not** restart the session; the app must create a new one. Sessions are single-use.                                                                                                                 |

---

## 3. Session and lifecycle facts worth designing against

Real API names (the `MWDAT*` prefix is the iOS module/Obj-C bridge name, **not** the Swift type prefix):

- **Entry point:** `Wearables` — Swift `enum` with `.shared: WearablesInterface` and a `configure()` that throws `WearablesError.alreadyConfigured` on a second call; Kotlin `object Wearables` with `initialize(context): DatResult<Unit, WearablesError>`.
- **Session:** `DeviceSession` with `start()`, `stop()`, `state`, `statePublisher`, `errorStream()`.
- **States:** `idle`, `starting`, `started`, `paused`, `stopping`, `stopped` (Android: SCREAMING_SNAKE_CASE).
- **Events:** iOS uses a custom `Announcer` protocol plus `AsyncStream` — **not Combine, not delegates**. Android uses `StateFlow`/`SharedFlow` plus a `DatResult<T, E: DatError>` value class.
- **Sessions are single-use.** After `stopped`, create a new one. `stop()` is fire-and-forget. Create the state stream _before_ `start()` or you miss the initial transitions.
- **Errors:** `RegistrationError`, `PermissionError`, `NavigationError`, `DeviceSessionError`, `StreamError`, `DisplayError`. `metaAINotInstalled` appears in three of them, which argues for promoting "Meta AI app not installed" to a first-class adapter error rather than mapping it through per-enum.
- **Permissions are two-level:** app-level grant plus per-device confirmation. `checkPermissionStatus` can report granted for the app while a newly paired device still needs confirmation. The adapter needs a granted-but-unconfirmed state.
- **The app never owns the consent UI.** Registration and permission grants happen inside the Meta AI app; our app can only launch the flow and observe a state transition. It needs an explicit "user never came back" outcome.

**Caution for whoever writes the native code:** the API reference's rendered signature blocks **strip `async` and `throws`** — confirmed across three modules. The sample apps are authoritative for effect signatures. Do not generate an interface from the reference pages; compile against the SDK.

**Known defects to design around:** the Android SDK crashes intermittently on rapid successive photo captures during streams over one minute (workaround: recycle the session). Not on Cynthia's path today, but it signals preview-stage stability. Also: no dash in the iOS Bundle ID, and glasses need >10% battery to install the companion app.

**A gap that will bite the companion app.** The iOS integration guide's required Info.plist keys are `NSBluetoothAlwaysUsageDescription` and `NSCameraUsageDescription`, plus `UIBackgroundModes` of `bluetooth-peripheral` and `external-accessory`. It **does not mention `NSMicrophoneUsageDescription` at all** — verified directly. Any app that captures HFP mic audio needs that key or iOS terminates it on first access. This is further evidence that Meta does not treat audio as a DAT concern (§1.1), and it means the integration guide is _incomplete_ as a checklist for an audio-only integration like ours. Add the key from the start.

---

## 4. What this means for Cynthia's escalation flow

The PRD's flow — Cynthia holds the client, asks the founder through the glasses, relays the answer — survives, with one honest amendment to the "founder should not need to open a phone" promise:

- **On Android**, hands-free is plausible via the documented FCM → foreground-service → A2DP chain.
- **On iOS**, hands-free requires the founder to have opted into an availability session first (PushToTalk), or degrades to a notification the founder taps. This is not a workaround to hide — it is the honest shape, and it maps cleanly onto the PRD's **availability mode** in the founder console. "Available" can mean "channel joined, prompts arrive hands-free."

**The fallback ladder (roadmap D.3) is therefore not defensive padding — it is the primary design.** Each rung requires a positive acknowledgement before it counts as delivered:

```
glasses audio  →  companion-app push  →  founder web inbox  →  honest client deferral
```

If no rung acknowledges before the escalation expires, the client gets a truthful deferral and exactly one follow-up is created. **Silence is never interpreted as a founder answer.** This is CLAUDE.md's core promise and the reason the ladder exists.

Two consequences for the orchestrator:

1. **Expiry is the orchestrator's timer, never the device's.** The adapter cannot be trusted to still be alive; a prompt that was never presented must still expire on schedule.
2. **Transcription confidence must be surfaced, not swallowed.** HFP capture is 8 kHz narrowband. CLAUDE.md requires confirming critical names, dates, prices, and commitments when confidence is low, so the adapter's contract carries a confidence value and the orchestrator gates on it.

---

## 5. MetaWearableAdapter contract (shape)

The server-side contract **terminates at the companion app**, not at the glasses. It is deliberately device-agnostic: the same events arise whether the founder answered through glasses, the companion app, the web inbox, or the simulator. That is precisely what makes the simulator honest rather than a fake — it implements the same contract, not a pretend one.

The typed package lands in roadmap 4.2; this is the shape it will take.

```ts
/** Transport-agnostic founder-prompting contract. Implemented by the real
 *  companion-app channel, the web inbox, and MetaWearableSimulator alike. */

type EscalationId = string & { readonly __brand: 'EscalationId' };

/** Where a prompt was presented / a response came from. Recorded on every
 *  event so the audit timeline can show which rung of the ladder answered. */
type FounderChannel = 'glasses' | 'companion_app' | 'web_inbox' | 'simulator';

type FounderAction = 'answer' | 'decline' | 'defer' | 'take_call';

interface WearablePrompt {
  escalationId: EscalationId;
  conversationId: ConversationId;
  /** Read aloud. Kept short — this is spoken into someone's ear mid-day. */
  spokenText: string;
  /** Same content for channels that render rather than speak. */
  displayText: string;
  allowedActions: readonly FounderAction[];
  expiresAt: string; // ISO-8601; authoritative copy lives with the orchestrator
  traceId: string;
}

type UndeliverableReason =
  | 'device_unavailable' // glasses disconnected, hinges closed
  | 'session_unavailable' // could not establish a session
  | 'permission_denied'
  | 'companion_app_unreachable'
  | 'platform_denied_background_audio' // the documented iOS case (§1.3)
  | 'founder_unavailable' // availability mode says do not disturb
  | 'timeout';

type DeliveryOutcome =
  | { status: 'presented'; channel: FounderChannel; presentedAt: string }
  | { status: 'undeliverable'; channel: FounderChannel; reason: UndeliverableReason };

/** Emitted only on explicit founder action, except `expired`. */
type FounderResponseEvent =
  | {
      kind: 'answered';
      escalationId: EscalationId;
      channel: FounderChannel;
      text: string;
      /** 0..1. Low values force the orchestrator to confirm critical details
       *  rather than act on a guess (CLAUDE.md Security). */
      transcriptionConfidence: number;
      audioRef?: string;
      receivedAt: string;
    }
  | { kind: 'declined'; escalationId: EscalationId; channel: FounderChannel; receivedAt: string }
  | { kind: 'deferred'; escalationId: EscalationId; channel: FounderChannel; receivedAt: string }
  /** Direct handoff. NEVER inferred — only an explicit affirmative action
   *  produces this, regardless of caller priority (CLAUDE.md invariant). */
  | { kind: 'took_call'; escalationId: EscalationId; channel: FounderChannel; receivedAt: string }
  /** Raised by the ORCHESTRATOR's timer, never by the device. */
  | { kind: 'expired'; escalationId: EscalationId; expiredAt: string };

type CapabilityStatus = 'live' | 'pending' | 'unsupported';

interface MetaWearableAdapter {
  /** Surfaced in the founder console's integration panel. The UI must never
   *  let a founder believe a pending capability is live (roadmap D.2). */
  readonly capabilities: Readonly<Record<string, CapabilityStatus>>;

  /** Idempotent on `idempotencyKey`: a retry never prompts the founder twice. */
  deliverPrompt(
    prompt: WearablePrompt,
    opts: { idempotencyKey: string; timeoutMs: number },
  ): Promise<DeliveryOutcome>;

  /** Client hung up, or another rung already answered. Best-effort. */
  cancelPrompt(escalationId: EscalationId, reason: string): Promise<void>;

  /** Responses for unknown or already-resolved escalation IDs are dropped
   *  with an audit event — never applied to a different conversation. */
  onFounderResponse(handler: (e: FounderResponseEvent) => void): () => void;

  health(): Promise<{ reachable: boolean; detail?: string }>;
}
```

Invariants this contract encodes, each traceable to CLAUDE.md:

- `took_call` cannot arise from silence or a generic reply — only an explicit action emits it.
- `expired` originates in the orchestrator, so a dead adapter cannot stall an escalation forever.
- `deliverPrompt` is idempotent, so a duplicate provider event or a retry never double-prompts.
- Every event names its `channel`, so the audit timeline shows which rung answered.
- `transcriptionConfidence` is mandatory on `answered`, so low-confidence audio cannot be silently trusted.

---

## 6. What cannot be verified without hardware and access

Split honestly, because the two blockers are different.

**Blocked on Meta account/approval (no glasses needed):** anything touching registration, permission review, Application ID issuance, release channels, or Developer Mode. Once access exists, MockDeviceKit makes the session state machine, registration flow, permission-denied path, and device lifecycle (pair, power, don/doff, fold, cap-touch) **CI-testable without hardware**.

**Blocked on physical glasses — cannot be simulated:**

1. Whether A2DP playback / HFP capture work **without** a DAT session (§1.2) — and, because the mock has no audio path, this appears untestable in CI even with account access.
2. Real end-to-end latency: push → wake → TTS → A2DP start; and the A2DP↔HFP route-switch cost.
3. Whether iOS actually permits activating a **mixable** audio session from a background push handler. Apple documents the error only for the _nonmixable_ case; the asymmetry is suggestive but is not affirmative permission.
4. Whether the Android FCM → foreground-service → A2DP chain works in practice, and whether FCM deprioritization degrades it over a 7-day window.
5. Real-world HFP capture quality at 8 kHz in a noisy environment, and resulting ASR accuracy on names, dates, and prices — which directly drives the confidence threshold.
6. What "certain features are unavailable while your session is active" actually means. Three sources quote the sentence; **none enumerates it.** Whether Meta AI, music, or phone calls are disabled during a session is the largest unresolved UX unknown and is not answerable from documentation.
7. Session reliability in daily use: hinge-close frequency, Bluetooth drop rate, reconnect behaviour.

---

## 7. Do we even need DAT for the MVP?

Stated plainly, because it may save a lot of work: **if E1 below shows audio works without a DAT session, Cynthia's MVP does not need the Device Access Toolkit.** The flow would be a companion app that receives a push, speaks over A2DP, captures over HFP, and posts the result back — with the glasses acting as a paired Bluetooth headset.

DAT would then be worth adding later for polish: sanctioned registration, device/session state, wear detection, and the App Connections entry that lets a founder see and revoke the integration.

This does not change the adapter contract in §5 by one line, which is the point of putting the boundary at the companion app.

---

## 8. Experiments to run when access and hardware arrive

Ordered by decisiveness per unit of effort.

- **E1 — Audio without DAT (decisive, ~1 hour).** Build a target that links **zero DAT symbols**. Pair the glasses through the Meta AI app only. Attempt A2DP TTS playback, then HFP capture. Then repeat with `Permission.microphone` explicitly requested, to test whether the vestigial iOS enum case is a hidden gate. Outcome determines whether DAT is on the critical path at all (§7).
- **E2 — iOS background audio activation (~30 min).** From a background push handler, call `AVAudioSession.setActive(true)` with category `.playback` and `mixWithOthers`, and log the exact `AVAudioSession.ErrorCode`. Resolves the mixable-session ambiguity Apple's docs leave open.
- **E3 — Android hands-free chain (~half day).** High-priority FCM → `startForegroundService` → `startForeground` with `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE | MEDIA_PLAYBACK` → A2DP playback. Measure end-to-end latency. Add the Companion Device Manager exemption as a hedge.
- **E4 — Route-switch budget (~1 hour).** Measure real A2DP→HFP switch time against Meta's 2-second sample sleep. This is the per-turn UX tax on any conversational design.
- **E5 — PushToTalk viability (iOS, ~1 day + entitlement wait).** Determine whether the entitlement is grantable for a glasses-companion app and whether PTT audio can be routed to A2DP glasses. Only worth starting if iOS parity is a product requirement.
- **E6 — Narrowband ASR accuracy (~half day).** Record real 8 kHz HFP captures of names, dates, and prices in a noisy room; measure ASR accuracy to calibrate the confidence threshold that triggers confirmation.

---

## 9. Sources

Meta: `wearables.developer.meta.com/docs/develop/dat/` (build-overview, build-integration-ios, build-integration-android, lifecycle-events, permissions-requests, microphones-and-speakers, mock-device-kit, testing-mdk-ios, testing-mdk-android, knownissues, set-up-release-channels, version-dependencies, display-*), the 0.8 API reference under `/docs/reference/{ios_swift,android}/dat/0.8/`, `github.com/facebook/meta-wearables-dat-{ios,android}` (README, CHANGELOG, sample apps), and `developers.meta.com/wearables/faq/` plus the DAT announcement blog posts.

Apple and Android: `AVAudioSession.ErrorCode`, `UIBackgroundModes`, PushToTalk, PushKit/CallKit eligibility, and `UNNotificationRequest` background-push guidance; FCM message priority, the Android 12 foreground-service background-start exemptions, and `FOREGROUND_SERVICE_CONNECTED_DEVICE`.

**Sourcing rule adopted for this spike:** only `wearables.developer.meta.com`, `github.com/facebook/meta-wearables-dat-*`, `developers.meta.com`, and first-party Apple/Android documentation count as evidence. One earlier research pass surfaced an `audioStreamingError` case from an unofficial gist using pre-0.7 type names; it contradicts the authoritative 0.8 `StreamError` and has been struck from the evidence base. It is recorded here so nobody reintroduces it.
