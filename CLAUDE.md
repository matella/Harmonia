# Harmonia — standing instructions

Harmonia is a private, offline-first relationship companion (Ionic Angular + Capacitor, native widgets and watch surfaces). **`Harmonia_Product_Spec.md` (repo root) is the source of truth**; `docs/` records how it is implemented.

## Before changing anything
- Read `docs/IMPLEMENTATION_PLAN.md` (status, blockers, next steps) and `docs/ARCHITECTURE.md`.
- Date/time behaviour is specified in `docs/DATE_AND_TIME_RULES.md`. Changing a rule means updating `shared/test-vectors/date-vectors.json` and every implementation (TypeScript, Kotlin `android/harmonia-core`, Swift `ios/Shared/HarmoniaCore`).
- Keep `docs/IMPLEMENTATION_PLAN.md` truthful: never mark something verified unless the command actually ran and passed.

## Layering rules
- `src/app/core/domain` and `src/app/core/i18n` are framework-free TypeScript: no Angular, Ionic or Capacitor imports. All "now" comes from an injected `Clock` — never `Date.now()`/`Temporal.Now` elsewhere.
- Use `Temporal` only via `core/domain/temporal.ts`. Calendar dates are `YYYY-MM-DD` strings / `PlainDate`, never UTC-midnight instants.
- Persistence goes through `SqlDriver` + repositories (`core/persistence`). Schema changes = a new append-only migration in `migrations.ts`.
- Platform APIs (Capacitor plugins, native bridges) live in `core/platform` behind interfaces with web/no-op fallbacks.
- Angular state uses signals (`core/state/app-store.ts`); the app is zoneless. Components are standalone + OnPush.
- All user-visible text goes in the catalogs: add every new key to `messages.en.ts`, `messages.fr.ts` and `messages.nl.ts` with the same placeholders (`catalogs.test.ts` enforces it). Whole sentences, plural objects; no string concatenation of sentence fragments. Native widget/watch text lives in Android `values{,-fr,-nl}/strings.xml` and the iOS `.xcstrings` catalogs.
- Persist first, then side effects (reminder reconcile, widget snapshot). A failed side effect must not roll back saved data.
- Privacy: never log names, dates, notes or notification bodies; widget snapshots contain only the documented fields (`docs/WIDGET_SNAPSHOT.md`).
- Network: the only outbound calls are opt-in anonymous usage events (`core/platform/usage-analytics.ts`, destination in `core/platform/usage-config.ts`, off by default). New events go in the closed schema `core/domain/usage-events.ts` (booleans, buckets, whitelisted words only) and `docs/USAGE_ANALYTICS.md`. Never send user-entered content, dates, exact counts, IDs or life-event categories. Partner sharing (when `core/platform/sync-config.ts` is set; null by default) talks only to that Supabase server and sends only ciphertext and the metadata listed in `docs/PARTNER_SYNC.md` §10. No other analytics, ads or network calls.

## Commands
Bun is the package manager (`bun install`, `bun.lock`); do not add `package-lock.json`. Run tests with `bun run test` — `bun test` would start Bun's own test runner instead.
- `bun run test` — domain/persistence tests (vitest, Node) + Angular component tests (`ng test`).
- `bun run test:domain` — fast framework-free suite only.
- `bun run lint`, `bun run typecheck`, `bun run build`.
- Android: `bun run android:build` (wraps `bunx cap sync android` + Gradle). Gradle needs `JAVA_HOME` set to a JDK ≥ 17 (Android Studio's JBR works); the Foojay plugin provisions the JDK 21 toolchain Capacitor plugins require.
- Kotlin unit tests (shared vectors): `cd android && ./gradlew :harmonia-core:test`.
- iOS/watchOS cannot be built on Windows; see `docs/IOS_SETUP.md`.

## Conventions
- Prettier (`.prettierrc`: print width 100, single quotes). Component selector prefix `hm-`.
- Tests: `*.test.ts` = framework-free (vitest, `vitest.config.mts`; includes `supabase/**` schema/RLS tests on PGlite); `*.spec.ts` = Angular (`ng test`).
- Partner sharing (in progress, `docs/PARTNER_SYNC.md`): crypto in `core/sync` (libsodium, always lazy-loaded), secrets only through `core/platform/secure-key-store.ts`, server schema in `supabase/migrations` (append-only, tested in `supabase/tests`).
- Do not add a backend, accounts, ads, remote fonts, or analytics beyond the opt-in usage events above.
