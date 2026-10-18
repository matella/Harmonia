# Anonymous usage sharing (opt-in)

Decided by the product owner on 2026-10-18: Harmonia may collect feedback on how the app is used, **only if the user opts in**, and never anything about the relationship itself. This departs from the original spec's non-goals (`Harmonia_Product_Spec.md` lines 24 and 89: no analytics in the first release, no third-party analytics). It stays within §12 ("no analytics … or outbound calls **by default**"): sharing is off until the user turns it on. Self-hosting Aptabase removes the "third-party" part.

## Behaviour

- **Destination:** [Aptabase](https://aptabase.com) (open source; EU or US cloud, or self-hosted), configured in `src/app/core/platform/usage-config.ts`. While `USAGE_CONFIG` is `null` the feature does not exist: no prompt, no setting, no network code path. It is `null` in this repository.
- **Native builds only.** The browser preview never sends.
- **Consent:**
  - Setting `usageSharing`, default `false`.
  - A one-time card on Home asks, but never in the session that completed onboarding. Either answer sets `usagePromptAnswered`.
  - The toggle stays in Settings › Privacy and data.
  - "Delete all data" discards the queue and clears all settings, so sharing is off again. No "deleted" event is ever sent.
- **Transport** (`UsageRecorder`):
  - In-memory queue only, nothing written to disk.
  - Batches of at most 25 events, sent after 30 s, at 10 queued events, or when the app goes to the background.
  - 10 s timeout. After a failure, a one-minute back-off; up to 3 attempts, then the events are dropped.
  - Requests use `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`.

## What each event contains

| Field | Value |
|---|---|
| `eventName` + `props` | From the closed schema in `src/app/core/domain/usage-events.ts`: booleans, count buckets (`0`, `1`, `2-5`, `6-20`, `21+`), screen names by template (`date_detail`, never an ID) and setting values. `isSafeUsageEvent` rejects anything else, and the recorder drops such events. |
| `timestamp` | Time of the event. |
| `sessionId` | Random, in memory, new on every cold start and after 1 h idle. Never stored. |
| `systemProps` | `locale` (the app's language only: `en`/`fr`/`nl`), `osName`, `appVersion`, `isDebug` (true for debuggable APKs / iOS DEBUG builds, via the native `buildInfo()` bridge; assumed true until it answers), `sdkVersion`. No device model, OS version or advertising ID. |

**Never sent:** names, titles, notes, photos, dates (including the start date and relationship length), exact counts, record IDs, reminder times or offsets, milestone categories (they describe life events), or the consent setting itself.

**Events:**
- `app_started`: once per cold start, the coarse setup.
- `screen_viewed`
- `onboarding_completed`
- `date_saved` and `date_deleted`
- `memory_saved` and `memory_deleted`
- `setting_changed`
- `export_created`
- `reminders_rechecked`
- `notification_permission`

## Inherent to any network request

The receiving server sees the device's **IP address** and the WebView's **User-Agent** string (device model and Android/iOS version). Harmonia cannot remove these from a WebView request and does not put them in events. DevTools also lists `Referer: https://localhost/` despite `no-referrer`; it contains no user information.

Aptabase's handling of IP addresses is governed by its own privacy policy, and must be checked and described in Harmonia's privacy policy before release. Self-hosting puts this under your control.

## Verified (Android emulator, API 37.2)

Verified with a temporary self-hosted config pointing at an unresolvable `.invalid` host, using DevTools `Network.requestWillBeSent`. No request reached a server.
- Before opting in, browsing screens produced **0 requests**.
- After opting in, batches contained only `screen_viewed {screen}` and `app_started` with the fields above.
- The body matched the unit test's expected shape, with `locale: "en"` and `osName: "android"`; after adding the native build flag, the debug APK sent `isDebug: true`.
- While offline, a failed batch was not resent on every new event (back-off).
- After switching the toggle off, **0 requests** over 35 s.

**Not verified:**
- That Aptabase's servers accept the CORS preflight from `https://localhost` (Android) and `capacitor://localhost` (iOS). The official web SDK sends the same `App-Key` header from browsers, but check this with a real key.
- iOS (including the `#if DEBUG` build flag).
- That Aptabase's dashboard shows the events.

## Release obligations when enabled

See `docs/RELEASE_CHECKLIST.md` → Usage analytics: App Store privacy label, Play Data safety, privacy policy URL, and the iOS privacy manifest entry, which is already declared.
