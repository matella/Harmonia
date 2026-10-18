# Release checklist

Nothing here is complete until checked on real builds. Items marked ✅ were verified in this repository's environment; everything else needs the stated owner action.

## Identity and naming
- [ ] Naming/trademark review for "Harmonia" (spec §2.2) — store, domain and trademark searches.
- [ ] Replace the placeholder id `harmonia.companion` with an id you control (see BRANDING.md); keep phone and Wear OS ids identical.
- [x] ✅ Original icon + splash generated (`scripts/generate-brand-assets.py`); adaptive + monochrome Android icons.

## Android (Google Play)
- [ ] Create an upload keystore; configure `signingConfigs.release` via `~/.gradle/gradle.properties` (never commit secrets); build `bun run android:release` (AAB) for phone and `:wear:bundleRelease` for Wear OS.
- [ ] Enable R8 (`minifyEnabled true`) and add keep rules for Capacitor plugins; re-test.
- [ ] Data safety form: no data collected or shared; data stored on device; deletion available in-app.
- [ ] Permissions review: POST_NOTIFICATIONS (contextual), RECEIVE_BOOT_COMPLETED, INTERNET (WebView runtime only). ✅ SCHEDULE_EXACT_ALARM removed from the merged manifest.
- [ ] Wear OS: test on a Wear OS 3+ emulator/watch (no Wear system image was installed here), screenshots for the watch listing.
- [ ] Store listing text/screenshots (phone, widgets, watch) without fictitious personal data presented as real.

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
- [ ] Accessibility pass on devices: TalkBack/VoiceOver order and labels, 200 % font scale, reduced motion, contrast in dark mode.
- [ ] Locale/time-zone manual checks: change device zone after scheduling a reminder; travel across a DST change.
- [ ] Airplane-mode smoke test on both platforms.

## Localization

- [ ] Native-speaker review of French and Dutch (app catalogs, Android `values-fr`/`values-nl`, iOS `.xcstrings` and `InfoPlist.xcstrings`).
- [ ] Store listings and screenshots in English, French and Dutch.
