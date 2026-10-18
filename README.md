# Harmonia

*Our time, together.* A private, offline-first relationship companion: a live relationship counter, important dates with reminders, a timeline of memories and photos, and native home-screen/lock-screen widgets and smartwatch complications. No account, no backend, no analytics — everything stays on the device.

- Product specification (source of truth): [`Harmonia_Product_Spec.md`](Harmonia_Product_Spec.md)
- Implementation status, test results, blockers: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Date rules: [`docs/DATE_AND_TIME_RULES.md`](docs/DATE_AND_TIME_RULES.md) · Widget contract: [`docs/WIDGET_SNAPSHOT.md`](docs/WIDGET_SNAPSHOT.md)

## Stack

| Part | Technology |
|---|---|
| App | Angular 22 (standalone, zoneless, signals) · Ionic 9 · Capacitor 8 · TypeScript 6.0 strict |
| Dates | Temporal (`temporal-polyfill`), shared JSON test vectors |
| Storage | SQLite — `@capacitor-community/sqlite` on devices, `sql.js` in the browser preview and tests |
| Reminders | `@capacitor/local-notifications` (inexact, local only) |
| Photos / export | `@capacitor/camera` (system photo picker), `@capacitor/filesystem`, `@capacitor/share`, `fflate` (ZIP) |
| Android widgets | Kotlin, AppWidget + RemoteViews, `android/harmonia-core` shared Kotlin module |
| Wear OS | Kotlin, Compose for Wear OS (Material 3), Complications Data Source API, Wearable Data Layer |
| iOS widgets / watchOS | Swift, SwiftUI, WidgetKit (App Intents), WatchConnectivity, `ios/HarmoniaCore` Swift package |
| Fonts | Fraunces (variable) and DM Sans, bundled locally (SIL OFL 1.1) |

### Toolchain used for this repository

Node 24.22 · Bun 1.4.3 (package manager and script runner) · Android SDK platform 37.0 (compileSdk 37, targetSdk 36) · Android Studio JBR 25 as Gradle launcher JVM · Gradle 9.8.1 · AGP 9.4.1 · Kotlin 2.4.21 · JDK 21 toolchain (auto-provisioned by the Foojay resolver). iOS requires macOS + Xcode 26+ (not available in the development environment; see [`docs/IOS_SETUP.md`](docs/IOS_SETUP.md)).

> TypeScript stays on 6.0: Angular 22 (`@angular/compiler-cli`, `@angular/build`) and typescript-eslint require `>=6.0 <6.1`. TypeScript 7 (the native Go compiler) can be adopted once Angular supports it.
>
> Bun blocks dependency lifecycle scripts by default; the only blocked one (`@parcel/watcher` build-from-source) is unnecessary because prebuilt binaries are used.

## Getting started

```bash
bun install --frozen-lockfile
```

```bash
bun start
```

Opens the browser preview at http://localhost:4200 (data is stored in IndexedDB; reminders and widgets are native-only and inert in the browser).

## Quality gates

> Use `bun run test`, not `bun test`: the latter starts Bun's own test runner instead of the package script (vitest + `ng test`).

```bash
bun run check
```

Runs everything below in sequence:

| Command | What it does |
|---|---|
| `bun run typecheck` | `tsc --noEmit` for app, Angular specs and framework-free tests |
| `bun run lint` | ESLint with angular-eslint (TypeScript + template accessibility rules) |
| `bun run test` | `test:domain` (vitest, Node: domain, persistence on real SQLite, integration) + `test:ui` (`ng test`, Angular components/services) |
| `bun run build` | Production web build into `dist/harmonia/browser` |

## Android

Requirements: Android SDK platform 37.0, a JDK ≥ 17 to launch Gradle (Android Studio's bundled JBR works; `scripts/gradle.mjs` finds it automatically), network access on first build (Gradle, dependencies, JDK 21 toolchain).

```bash
bun run android:build
```

Builds the web app, syncs Capacitor and assembles `android/app/build/outputs/apk/debug/app-debug.apk` (phone). The Wear OS APK is `bun run android:sync && node scripts/gradle.mjs :wear:assembleDebug` → `android/wear/build/outputs/apk/debug/wear-debug.apk`.

```bash
bun run android:test
```

Runs the Kotlin unit tests (shared date vectors, snapshot parsing, privacy filtering).

Install on a running emulator/device: `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`. Open in Android Studio with `bunx cap open android`.

## iOS and watchOS

Requires macOS with Xcode 26+. Swift sources for the bridge plugin, WidgetKit extension, watch app and complications are in `ios/`; the extension/watch targets must be added in Xcode once — step-by-step in [`docs/IOS_SETUP.md`](docs/IOS_SETUP.md).

```bash
bun run ios:sync
```

```bash
cd ios/HarmoniaCore && swift test
```

## Project layout

```text
src/app/core/domain        Pure date/recurrence/validation/reminder/snapshot/export rules (+ *.test.ts)
src/app/core/i18n          Message catalog, plural rules, Intl formatting
src/app/core/persistence   SqlDriver, migrations, repositories
src/app/core/platform      Notification port, widget bridge, media storage
src/app/core/services      Angular services orchestrating persist → side effects
src/app/core/state         Signal store
src/app/features           Onboarding, Home, Timeline, Dates, Memories, Settings
src/app/shared             Design-system components, pipes, utilities
src/theme                  Tokens, Ionic mapping, base and component styles
shared/test-vectors        Canonical date vectors used by TS, Kotlin and Swift tests
android/                   Capacitor app + widgets, harmonia-core (Kotlin), wear (Wear OS)
ios/                       Capacitor app + HarmoniaCore (Swift package), widget and watch sources
scripts/                   gradle.mjs (JDK-aware Gradle runner), generate-brand-assets.py
docs/                      Architecture, rules, plan, setup and release documents
```

## Privacy

Harmonia stores everything locally (SQLite + app-private files), makes no network requests of its own, includes no analytics or ads, excludes its data from cloud backups, keeps notifications discreet by default, and shows only the fields documented in `docs/WIDGET_SNAPSHOT.md` on widgets and watches. Users can export a ZIP (JSON + photos) or delete everything from *Settings › Privacy and data*.

## Licenses

Third-party notices are generated into `dist/harmonia/browser/3rdpartylicenses.txt` by the production build. Fonts: Fraunces and DM Sans, SIL Open Font License 1.1 (`node_modules/@fontsource-variable/fraunces/LICENSE`, `node_modules/@fontsource/dm-sans/LICENSE`).
