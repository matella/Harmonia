# Release checklist

Nothing here is complete until checked on real builds. Items marked ✅ were verified in this repository's environment; everything else needs the stated owner action.

## Identity and naming
- [ ] Naming/trademark review for "Harmonia" (spec §2.2) — store, domain and trademark searches. A first web search (2026-10-24, BRANDING.md) found no exact match; the register searches and the decision remain.
- [ ] Replace the placeholder id `harmonia.companion` with an id you control (see BRANDING.md); keep phone and Wear OS ids identical.
- [x] ✅ Original icon + splash generated (`scripts/generate-brand-assets.py`); adaptive + monochrome Android icons.

## Android (Google Play)
- [ ] Create an upload keystore; configure `signingConfigs.release` via `~/.gradle/gradle.properties` (never commit secrets); build `bun run android:release` (AAB) for phone and `:wear:bundleRelease` for Wear OS.
- [x] ✅ R8 on for phone and Wear (`minifyEnabled`, `shrinkResources`). Capacitor's own keep rules apply; only the excluded ML Kit needed a rule. Release APK tested on the API 37.2 emulator (2026-10-24): onboarding, photo picker, notification prompt and reminder alarm, app lock (turned on with the PIN, then locked on return and unlocked), export share sheet, small widget; no missing-class errors. Not run under R8 yet: the QR scanner and the secure store (both only reachable with sharing on), the wide widget and the widget settings screen, and the Wear release build on a watch.
- [ ] Data safety form: no data collected or shared; data stored on device; deletion available in-app.
- [ ] Permissions review: POST_NOTIFICATIONS (contextual), RECEIVE_BOOT_COMPLETED, INTERNET (WebView runtime only). ✅ SCHEDULE_EXACT_ALARM removed from the merged manifest.
- [ ] Wear OS: test on a Wear OS 3+ emulator/watch (no Wear system image was installed here), screenshots for the watch listing.
- [ ] Store listing text/screenshots (phone, widgets, watch) without fictitious personal data presented as real. Text drafts in EN/FR/NL: docs/STORE_LISTING.md; screenshots not made.

## iOS (App Store)
- [ ] Complete docs/IOS_SETUP.md on macOS; `swift test` in `ios/HarmoniaCore`.
- [ ] App Group `group.harmonia.companion` registered for app, widget, watch app and watch widget ids.
- [ ] Privacy nutrition label: Data Not Collected. ✅ `PrivacyInfo.xcprivacy` included in the App target (add equivalents to extensions if Xcode flags required-reason APIs).
- [ ] Usage strings reviewed (photos/camera). Export compliance: `ITSAppUsesNonExemptEncryption = NO` set.
- [ ] TestFlight on iPhone + Apple Watch; Lock Screen and Smart Stack placement.

## Quality
- [x] ✅ `bun run check` (typecheck, lint, 136 domain/persistence/integration tests, 9 Angular specs, production build).
- [x] ✅ Kotlin unit tests (`bun run android:test`), Android lint: 0 errors.
- [x] ✅ Android emulator smoke test (API 36.1): onboarding, native SQLite persistence across reinstall, photo picker + EXIF orientation, contextual notification permission, inexact reminder alarm, small/medium widgets, widget privacy update, deep link, process death, delete-all clears widgets and reminders, export share sheet.
- [ ] Accessibility pass on devices: TalkBack/VoiceOver order and labels, 200 % font scale, reduced motion, contrast in dark mode. Done on the Android emulator (2026-10-24, IMPLEMENTATION_PLAN): 200 % text, names in the accessibility tree, dark widgets. Left: TalkBack gestures and speech, VoiceOver, reduced motion.
- [ ] Locale/time-zone manual checks: change device zone after scheduling a reminder; travel across a DST change. Zone change and reboot checked on Android (2026-10-24); DST on a device not run (the emulator image can't set its clock).
- [ ] Airplane-mode smoke test on both platforms. Android: an offline sync failure and the later sync checked (2026-10-24); iOS not run.

## Localization

- [ ] Native-speaker review of French and Dutch (app catalogs, Android `values-fr`/`values-nl`, iOS `.xcstrings` and `InfoPlist.xcstrings`).
- [ ] Store listings and screenshots in English, French and Dutch.

## Usage analytics (only if `USAGE_CONFIG` is set)

- [ ] Create the Aptabase app (EU region, or self-hosted) and set `src/app/core/platform/usage-config.ts`; use a separate app/key for test builds.
- [ ] Verify with the real key that events arrive (CORS preflight from `https://localhost` and `capacitor://localhost`).
- [ ] **Privacy policy URL** (required by both stores once any data is collected) describing the events, the destination, IP/User-Agent handling by the server, and that sharing is opt-in. Blocked: no domain/website yet.
- [ ] App Store privacy label: Usage Data → Product Interaction, not linked to the user, not used for tracking, purpose Analytics (matches `PrivacyInfo.xcprivacy`).
- [ ] Google Play Data safety: App activity → App interactions, collected, optional, not shared, encrypted in transit, not linked to an identity.
- [ ] If shipping without usage sharing, set `USAGE_CONFIG = null` and remove the Product Interaction entry from `PrivacyInfo.xcprivacy`.
