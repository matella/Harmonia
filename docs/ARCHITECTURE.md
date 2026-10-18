# Architecture

Harmonia is a local-first Ionic Angular + Capacitor app with native widget and watch surfaces. There is no backend, account, analytics or network dependency. The source of truth is a SQLite database on the device; widgets and watches consume a small, versioned, privacy-filtered snapshot.

```mermaid
flowchart TD
    UI[Angular / Ionic screens<br/>features/*] --> Store[AppStore signals<br/>core/state]
    UI --> Services[Domain services<br/>core/services]
    Services --> Repo[Repositories<br/>core/persistence]
    Repo --> Driver{SqlDriver}
    Driver -->|iOS / Android| CapSQLite[@capacitor-community/sqlite]
    Driver -->|browser preview, tests| SqlJs[sql.js + IndexedDB]
    Services --> Domain[Pure domain rules<br/>core/domain]
    Services --> Ports[Platform ports<br/>core/platform]
    Ports --> Notif[@capacitor/local-notifications]
    Ports --> Bridge[HarmoniaWidgets bridge plugin]
    Bridge --> APrefs[Android SharedPreferences] --> AW[AppWidgets + Wear Data Layer]
    AW --> Wear[Wear OS complication + app]
    Bridge --> AppGroup[iOS App Group UserDefaults] --> IW[WidgetKit extension]
    Bridge --> WC[WatchConnectivity] --> Watch[watchOS app + complications]
```

## Layers

| Layer | Location | Rules |
|---|---|---|
| Domain | `src/app/core/domain` | Framework-free TypeScript. Dates via Temporal (`temporal.ts`), "now" via injected `Clock`. Duration, occurrence, validation, reminder planning/reconciliation, widget snapshot, export format. 100 % unit-tested in Node. |
| i18n | `src/app/core/i18n` | Typed message catalog (`messages.en.ts`), CLDR plural selection, `Intl` date/number/list formatting. No Angular. |
| Persistence | `src/app/core/persistence` | `SqlDriver` interface, two drivers, append-only transactional migrations, one repository per aggregate. Tested against real SQLite (sql.js). |
| Platform | `src/app/core/platform` | Interfaces + adapters for notifications, the widget bridge, photo picking/storage. Web fallbacks are no-ops or browser equivalents. |
| Services | `src/app/core/services` | Angular injectables that orchestrate: persist → reload store → side effects. |
| State | `src/app/core/state/app-store.ts` | Signals for persisted data; `computed` for derived values (counter, upcoming, past). Zoneless change detection. |
| Presentation | `src/app/features/*`, `src/app/shared/*` | Standalone OnPush components; shared design-system components; global SCSS tokens in `src/theme`. |
| Native | `android/harmonia-core`, `android/app/.../widgets`, `android/wear`, `ios/HarmoniaCore`, `ios/HarmoniaWidget`, `ios/HarmoniaWatch*` | Kotlin and Swift. Consume only the snapshot. The minimal date rules are ported and tested against `shared/test-vectors/date-vectors.json`. |

## Key flows

**Write path (every user change).** Component → service (`MilestoneService`, `ProfileService`, …) → repository transaction → `SyncService.afterChange()`:
1. reload all state from SQLite into `AppStore`;
2. `ReminderService.reconcile()` — `planReminders()` computes the exact desired notification set; `reconcileReminders()` cancels stale IDs and (re)schedules planned ones;
3. `WidgetService.refresh()` — builds the snapshot; only writes it (and triggers OS reloads) when its fingerprint changed.

A failure in step 2 or 3 never rolls back the saved data; the user gets a toast pointing to *Settings › Reminders › Recheck reminders*.

**Cold start.** `provideAppInitializer` → `BootstrapService.start()`: open database → migrate (transactional; failures show a recovery screen and never wipe data) → load state → route guard decides onboarding vs. Home → deferred side effects (reconcile reminders, refresh snapshot, orphan-media cleanup).

**Lifecycle.** `LifecycleService` refreshes `now` at minute boundaries while foregrounded only, and on resume reconciles reminders and the snapshot and asks widgets to reload if the day or time zone changed. The counter-detail screen ticks per second only while visible. No background polling exists.

**Deep links.** Widgets/complications open `harmonia://home` / `harmonia://dates`; notifications carry an in-app route. `routeForLink()` accepts only known shapes.

## Notifications

- Planned in the domain from persisted rules; each rule owns a monotonic 32-bit `notification_id` (`id_sequences` table) that survives edits of time/wording, so rescheduling replaces rather than duplicates.
- Only the next occurrence per rule is scheduled, capped at 60 (iOS limit 64); later ones are planned on the next launch/resume.
- Android: inexact alarms (`isExactNotification: false`; the plugin's `SCHEDULE_EXACT_ALARM` permission is removed from the merged manifest). The plugin restores alarms after reboot; the app also reconciles on start.
- Permission is requested only when the user saves a date with reminders enabled; denial is shown in-line and never re-prompted.

## Widgets and watches

See `docs/WIDGET_SNAPSHOT.md` for the contract.

- **Android** (`android/app/src/main/java/harmonia/companion/widgets`): `HarmoniaWidgetsPlugin` (Capacitor) → `SnapshotStore` (SharedPreferences) → `WidgetRenderer` (RemoteViews) for `HarmoniaSmallWidget` (2×2) and `HarmoniaMediumWidget` (4×2). Per-instance options in `WidgetConfigureActivity`. Refresh: data changes, an inexact alarm after local midnight (`DayBoundaryScheduler`), `updatePeriodMillis` (6 h), and time/zone/locale/boot broadcasts. Rendering never needs the WebView.
- **Wear OS** (`android/wear`): `SnapshotListenerService` receives the Data Layer item `/harmonia/snapshot`; `DaysComplicationService` returns a 7-day `ComplicationDataTimeline` (short text, long text, monochromatic image); `WearMainActivity` (Compose for Wear OS) shows duration, days and the next date, with "Open on phone".
- **iOS** (`ios/HarmoniaWidget`): `AppIntentConfiguration` widgets for `systemSmall`, `systemMedium`, `accessoryCircular/Rectangular/Inline`, reading the App Group snapshot; timelines contain one entry per upcoming local midnight.
- **watchOS** (`ios/HarmoniaWatch`, `ios/HarmoniaWatchWidget`): the watch app receives the snapshot via `WCSession.updateApplicationContext`, caches it in its own App Group and reloads its WidgetKit complications (circular, corner, rectangular, inline).

## Decisions

| Decision | Why |
|---|---|
| Angular 22 + TypeScript 6.0 (not 7) | Latest Angular; its compiler and typescript-eslint require TypeScript `>=6.0 <6.1`. Bun is the package manager (`bun.lock`). |
| Temporal polyfill, imported explicitly | Correct calendar/zone arithmetic with explicit DST disambiguation; identical behaviour in all WebViews and Node. |
| Own `SqlDriver` + sql.js for web/tests | Repositories and migrations are tested with real SQL in Node; avoids the jeep-sqlite web stack. |
| Key/value `app_settings` | New settings need only a default and validator — no migration. |
| Anchor-based month arithmetic | Avoids "N years, 12 months" for clamped starts while matching the spec's years→months→days order otherwise (see DATE_AND_TIME_RULES.md). |
| RemoteViews instead of Glance on Android | Fewer Compose/Gradle dependencies in the Capacitor app module; full API 24+ support. |
| Snapshot includes upcoming dates ~13 months ahead | Widgets roll over to the next date without the app running. |
| Photos re-encoded on import | Orientation baked in, EXIF/GPS metadata stripped, size bounded; thumbnails for lists. |
| Capacitor `loggingBehavior: 'none'` | The native bridge otherwise logs plugin results (SQL rows, notification text) in debug builds. |
| Inexact alarms only | Spec: no exact-alarm access; dates don't need minute precision. |
| Local `HarmoniaCore` Swift package | Shared by widget/watch targets; `swift test` runs the shared vectors on any Mac without Xcode project changes. |
| AGP 9.4.1 + Gradle 9.8.1 + Kotlin 2.4.21, Foojay toolchains | Latest stable. Capacitor 8 plugins still apply `org.jetbrains.kotlin.android` and the legacy variant API, so `gradle.properties` sets `android.builtInKotlin=false` and `android.newDsl=false` until they migrate. Foojay provisions the JDK 21 that Capacitor plugins require; Gradle runs on Android Studio's JBR 25. |
| compileSdk 37, targetSdk 36 | Latest AndroidX/Wear Compose libraries require compiling against API 37; runtime behaviour stays at API 36, the level Capacitor 8 targets. |
| Product identifiers `harmonia.companion` | Replaceable slug not derived from a domain (see BRANDING.md). |
