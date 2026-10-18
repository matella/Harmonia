# iOS & watchOS setup (requires macOS + Xcode 26+)

This repository was developed on Windows, where iOS/watchOS code cannot be compiled. Everything below is written and reviewed, but **none of the Swift code has been compiled or run yet**. Follow these steps on a Mac and record results in `docs/IMPLEMENTATION_PLAN.md`.

## 0. Prerequisites

- macOS with Xcode 26.0+ (Capacitor 8 minimum), Node ≥ 22.12 / 24.x, an Apple Developer team for App Groups.
- `bun install --frozen-lockfile && bun run ios:sync` (builds the web app and runs `cap sync ios`).

## 1. Shared Swift core (no Xcode project changes needed)

```bash
cd ios/HarmoniaCore && swift test
```

Runs the shared date vectors (`shared/test-vectors/date-vectors.json`) and snapshot/privacy tests against the Swift port. Fix any divergence before continuing.

## 2. Main app target (already wired)

Already done in the repository:
- `App/MainViewController.swift` registers `HarmoniaWidgetsPlugin` (Capacitor `CAPBridgedPlugin`) and activates `WatchBridge` (WatchConnectivity).
- `SceneDelegate` and `Main.storyboard` use `MainViewController`.
- `App.entitlements` declares the App Group `group.harmonia.companion`; `CODE_SIGN_ENTITLEMENTS` is set for Debug/Release.
- `Info.plist`: `harmonia://` URL scheme, photo/camera usage strings, Handoff activity `harmonia.companion.open`, `arm64`.
- `PrivacyInfo.xcprivacy` (no tracking, no collected data, UserDefaults reasons).

Steps:
1. Open `ios/App/App.xcodeproj`. Select the **App** target › Signing & Capabilities › choose your team.
2. Confirm the **App Groups** capability shows `group.harmonia.companion` (create it in the developer portal if prompted).
3. Build & run on an iPhone simulator. Check: onboarding, persistence after relaunch, reminders (Settings › Notifications), export share sheet.

## 3. Add the local package

File › Add Package Dependencies… › Add Local… › select `ios/HarmoniaCore`. Do **not** add it to the App target (the app doesn't need it); add it to the extension targets below.

## 4. Widget extension (iOS 17+)

1. File › New › Target… › **Widget Extension**. Product name `HarmoniaWidget`, bundle id `harmonia.companion.widget`, **uncheck** "Include Live Activity" and "Include Configuration App Intent" (the repository provides its own).
2. Delete the template Swift files Xcode generated; add the files from `ios/HarmoniaWidget/` (`HarmoniaWidget.swift`, `HarmoniaWidgetViews.swift`, `Localizable.xcstrings`) to the **HarmoniaWidget** target. Use `ios/HarmoniaWidget/Info.plist` and `HarmoniaWidget.entitlements` for the target (Build Settings › Info.plist File / Code Signing Entitlements).
3. Target › General › Frameworks: add **HarmoniaCore**. Deployment target **iOS 17.0** (AppIntentConfiguration, `containerBackground`).
4. Signing & Capabilities: App Groups → `group.harmonia.companion`.
5. Ensure the App target embeds the extension (Xcode does this when creating the target: "Embed Foundation Extensions").
6. Run the app once, then add widgets: Home Screen (small, medium) and Lock Screen (circular, rectangular, inline). Verify placeholder before onboarding, real values after, privacy modes in Settings › Widgets and watch, and that tapping opens Home.

## 5. watchOS app + complications (watchOS 10+)

1. File › New › Target… › **watchOS › App** ("Watch App for existing iOS App"), product name `HarmoniaWatch`, bundle id `harmonia.companion.watchkitapp`. Replace the generated Swift files with `ios/HarmoniaWatch/*.swift` and add `Localizable.xcstrings`.
2. File › New › Target… › **watchOS › Widget Extension**, product name `HarmoniaWatchWidget`, embedded in `HarmoniaWatch`. Replace generated files with `ios/HarmoniaWatchWidget/*` (Swift, Info.plist, entitlements, xcstrings).
3. Add **HarmoniaCore** to both watch targets; deployment target **watchOS 10.0**.
4. App Groups on both watch targets: `group.harmonia.companion` (the watch has its own container; the iPhone sends data with WatchConnectivity, not via the group).
5. Run the paired iPhone + Watch simulators: after onboarding on the phone, the watch app should show the duration; add the complication to a watch face (circular, corner, rectangular, inline) and Smart Stack.

## 6. Manual checks to record

- [ ] `swift test` in `ios/HarmoniaCore` passes.
- [ ] App builds/runs; native SQLite persists across relaunch.
- [ ] Notification permission is asked only when saving a date with reminders; reminders appear at the chosen local time (test with a near-future reminder).
- [ ] Widgets: placeholder (no profile), small/medium/lock-screen values, privacy modes, deep link, refresh after edits, light/dark, Dynamic Type.
- [ ] Delete all data → widgets and watch show the placeholder.
- [ ] Watch app + complications show data after phone changes; fallback icon with no data.
- [ ] Export share sheet saves a ZIP to Files.
