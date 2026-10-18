# Implementation plan and status

Last updated: 2026-10-18. Legend: **Done** = implemented; **Tested** = automated tests pass; **Verified** = exercised on an Android emulator (phone API 36.1, later API 37.2 with 16 KB pages; Wear OS 7 / API 37) or in the browser preview; **Unverified** = written but not compiled/run here; **Blocked** = needs a resource not available in this environment.

## Environment (Phase 0)

| Tool | Found | Notes |
|---|---|---|
| Node / Bun | 24.22.0 / 1.4.3 | Bun is the package manager (`bun.lock`) and script runner; Angular CLI configured with `packageManager: bun` |
| JS toolchain | Angular 22.2.3, TypeScript 6.0.3, angular-eslint 22.6, ESLint 10.13, Vitest 5.0.5, jsdom 30 | TypeScript 7 not usable yet: Angular 22 and typescript-eslint require `>=6.0 <6.1` |
| Android SDK | platforms 36, 37.0, 37.2; AVDs `Medium_Phone` (API 37.2, Play, 16 KB pages) and `Wear_OS_XL_Round` (Wear OS 7, API 37) | compileSdk 37, targetSdk 36 |
| Android build | AGP 9.4.1, Gradle 9.8.1, Kotlin 2.4.21, Compose BOM 2026.09.00, Wear Compose 1.7.1 | `android.builtInKotlin=false` + `android.newDsl=false` because Capacitor 8 plugins still use the Kotlin plugin and legacy variant API |
| JDK | Android Studio JBR **25** only (no JDK 17/21 on PATH) | Gradle runs on 25; Foojay provisions JDK 21 toolchain for Capacitor plugins |
| macOS / Xcode / Swift | **Not available** (Windows 11) | iOS & watchOS cannot be compiled or simulated here |

## Phase status

### Phase 0 — Repository and toolchain inspection — Done
CLAUDE.md, README, docs (ARCHITECTURE, DATE_AND_TIME_RULES, WIDGET_SNAPSHOT, IOS_SETUP, BRANDING, RELEASE_CHECKLIST, PRODUCT_SPEC pointer) in place.

### Phase 1 — Runnable foundation and design system — Done, Verified
- Angular 22 + Ionic 9 + Capacitor 8 app shell, routing (tabs + stacked pages), guards, zoneless signals.
- Design tokens (light/dark, berry/sage accents), Ionic theme mapping, bundled Fraunces Variable + DM Sans, focus styles, reduced motion.
- Shared components: counter, next-milestone card, milestone row, photo frame, empty state, date/time field, reminder-offset selector, confirm dialogs, widget preview, choice list, emblem.
- No mock data anywhere: the app starts at onboarding.

### Phase 2 — Profile, counter, persistence — Done, Tested, Verified
- SQLite schema v1 + transactional migration runner (rollback on failure, refuses newer schemas, never wipes).
- Onboarding (start date required, optional time, name, photo, optional yearly anniversary + reminder), profile editor (all fields, day-counting zone).
- Counter: calendar/total days/weeks + precise (only with a start time; seconds only on the detail screen while visible). Theme and counter preferences persist.
- Verified: data survives reload (browser) and reinstall/relaunch (Android).

### Phase 3 — Milestones, timeline, memories — Done, Tested, Verified
- Milestone CRUD with categories, optional time, yearly recurrence, per-milestone Feb 29 policy, notes, cover photo, pin; delete with "keep memories" vs "delete memories".
- Dates tab (All/Upcoming/Past/Annual, collapsible past), timeline (beginning, entries, today marker, order toggle, jump to latest), memories grid, memory editor (multi-photo, link to a date) and detail.
- Photos: system picker (no library permission), EXIF orientation applied, metadata stripped, 2048 px image + 480 px thumbnail in app-private storage; orphan cleanup limited to `media/`. Verified on Android with an EXIF-6 test photo.

### Phase 4 — Reminders — Done, Tested, Verified (Android)
- Per-date offsets (on the day / 1 / 3 / 7 / custom 0–365), time, privacy flag; app defaults; global pause; discreet copy by default.
- Planner + idempotent reconciler with stable 32-bit notification IDs, 60-notification cap, leap-day policy, DST policy; reconcile on change, launch, resume, time-zone change; "Recheck reminders" with honest report.
- Contextual permission (only when saving a date with reminders); denial shown, never re-prompted.
- Verified on Android: permission prompt appears only after enabling a reminder; inexact alarm at 2027-08-13 09:00 for the day-before reminder; delete-all removes it.
- Fixed during verification: plugin default `isExactNotification: true` opened the "Alarms & reminders" settings → now `false`, and `SCHEDULE_EXACT_ALARM` removed from the manifest.

### Phase 5 — Phone widgets
- **Android — Done, Tested, Verified:** small (2×2) and medium (4×2) RemoteViews widgets, per-instance configuration activity, privacy modes, deep links, day-boundary inexact alarm + `updatePeriodMillis` + clock/locale/boot receivers, placeholder state. Verified: gallery previews (placeholder), live values, privacy/counter change propagates immediately, renders after process death, tap opens Home, delete-all shows placeholder.
- **iOS — Done, Unverified (Blocked: no macOS/Xcode):** bridge plugin wired into the Xcode project (App Group write + `reloadAllTimelines` + WatchConnectivity); WidgetKit extension sources for systemSmall/Medium and accessoryCircular/Rectangular/Inline with App Intent configuration and 7-day timelines; target creation steps in IOS_SETUP.md.

### Phase 6 — Watch capabilities
- **Wear OS — Done, Verified on the Wear OS 7 emulator (except live Data Layer sync):** Data Layer listener, complication data source (short text, long text, monochromatic image; 7-day timeline; placeholder fallback), Compose for Wear OS screen with "Open on phone" (berry button). Verified: placeholder screen without data; with the phone's real snapshot copied into the watch cache (privacy "Everything") the screen shows "2 years, 4 months, 4 days / 856 days together / Our anniversary, in 239 days" — identical to the phone; "Days together · Harmonia" appears in the watch-face complication picker, renders 856 with the rings mark on the face, and tapping it opens the app. **Not verified:** phone → watch delivery over the Data Layer (pairing the emulators needs the Wear OS companion app and a Google sign-in on the phone).
- **watchOS — Done, Unverified (Blocked: no macOS/Xcode):** SwiftUI watch app (WatchConnectivity receiver, App Group cache, Handoff), WidgetKit complications (circular, corner, rectangular, inline).

### Phase 7 — Settings, export, accessibility, hardening — Done (device accessibility audit pending)
- Settings: profile, appearance (theme, accent, counter, leap policy), reminders (permission state, defaults, recheck), widgets & watch (privacy, counter, live preview), privacy & data (statement, ZIP export with photos, delete everything), about/licences.
- Delete-all cancels reminders, wipes records and media, resets widget/watch snapshot. Android backups and device transfer excluded.
- Accessibility: semantic headings/landmarks, labelled controls, errors announced next to fields, status not by color alone, 44 px targets, reduced motion, template a11y lint rules pass. **Pending:** TalkBack/VoiceOver and 200 % font-scale passes on devices.

### Phase 8 — Release preparation — Partially done
Done: original icons/splash, replaceable identifiers, versioning (1.0.0), permission strings, iOS privacy manifest, release checklist. Pending: signing, release builds, R8, store metadata/screenshots, naming review (see RELEASE_CHECKLIST.md).

## Test and build results (2026-10-18, this environment, after the toolchain upgrade)

| Check | Command | Result |
|---|---|---|
| Full JS gate | `bun run check` | ✅ typecheck, lint (all files pass), 11 files / 136 domain tests, 2 files / 9 Angular specs, production build 1.11 MB initial (≈256 kB transfer), no warnings |
| Kotlin core | `bun run android:test` (`:harmonia-core:test`) | ✅ 9 tests (all shared vectors), re-run after `cleanTest` |
| Android app + Wear builds | `bun run android:build`, `:wear:assembleDebug` | ✅ on AGP 9.4.1 / Gradle 9.8.1 / Kotlin 2.4.21 |
| Android lint | `:app:lintDebug :wear:lintDebug` | ✅ 0 errors (10 + 3 warnings: API-level attributes, unused resources, style) |
| Android API 37.2, 16 KB pages | fresh install, onboarding via WebView DevTools | ✅ native SQLite (SQLCipher lib) loads and migrates; counter 2 y 4 m 4 d / 856 days for 2024-06-14; contextual notification prompt; inexact alarm 2027-06-13 09:00 (window 1 h) |
| Capacitor bridge logging | logcat after onboarding | ✅ `loggingBehavior: 'none'` → no `Capacitor/Console` lines (before: SQL results were logged in debug builds) |
| 200 % font: tab labels | `font_scale 2.0` | ✅ labels end with an ellipsis ("Memor…") instead of clipping |
| Wear OS app + complication | Wear OS 7 emulator | ✅ see Phase 6 |
| Medium widget on API 37.2 | Pixel launcher widget picker → Add | ✅ listed with both sizes and descriptions; renders "You and Sam / 856 days / Our anniversary, June 14, in 239 days" (privacy "Everything") |
| Bun dev server | `bunx ng serve` (`.claude/launch.json`) | ✅ serves the app; file watching rebuilds on change (prebuilt `@parcel/watcher-win32-x64`) |
| Earlier Android checks (API 36.1, before the upgrade) | manual via adb | ✅ time-zone change, reboot, edit milestone (no duplicate alarms), time picker + precise counter, dark mode, export ZIP, small widget, widget refresh/reboot paths (Phase 5) — not repeated after the upgrade |
| Swift `HarmoniaCore` tests | `swift test` | ⛔ not run (no Swift toolchain) |
| iOS / watchOS builds | Xcode | ⛔ not run (no macOS); `@capacitor/text-zoom` iOS path and the Swift `monthDay` fix are therefore uncompiled |

## Known limitations

- Widgets/complications refresh within OS budgets; Android's midnight alarm is inexact and may arrive late (counts are recomputed whenever drawn). iOS timelines advance at local midnights but WidgetKit may delay reloads.
- Reminders: only the next occurrence of each rule is scheduled; if the app is never opened for over a year, the following year's reminder is scheduled on the next launch. Android delivery is inexact (minutes, occasionally up to the system's window).
- Android widgets follow the system light/dark appearance (not the in-app override) and use the platform serif font (Fraunces is not bundled into RemoteViews).
- Force-stopping the app on Android 15+ greys out its widgets until the app is reopened (OS policy).
- Export is share-sheet based; there is no in-app import yet (the export parser validates and versions the format for a future import).
- A future-start "countdown" mode is not implemented; future start dates are rejected by validation.
- Only English copy ships; the catalog and formatting are localization-ready (regional date formats already follow the device).
- Export builds the ZIP in memory; very large photo libraries may need streaming.

## Manual verification still required

1. macOS: everything in `docs/IOS_SETUP.md` §6.
2. Wear OS: pair the phone and watch emulators (Android Studio → Device Manager → Pair Wearable; needs the Wear OS app and a Google account on the phone) and confirm a privacy change on the phone reaches the watch; then a real watch.
3. Devices: TalkBack/VoiceOver, large fonts, dark mode widgets, airplane mode, time-zone/DST changes with pending reminders, reboot (reminders restored, widget day boundary).

## Next concrete steps

1. On a Mac: run `swift test`, add the three Xcode targets per IOS_SETUP.md, fix any compile issues, verify widgets/watch.
2. Pair phone + watch and verify Data Layer sync end to end; re-run the reboot/time-zone/widget-refresh checks on API 37.2.
3. Device accessibility pass; fix findings.
4. Signing + release builds (AAB/IPA), R8 rules, store metadata and screenshots; naming review.
5. Optional next features from the spec backlog: data import from export, French/Dutch catalogs, future-start countdown mode.
