# iOS & watchOS setup (requires macOS + Xcode 26+)

First compiled and run on 2026-10-22: Xcode 26.3 (17C529) on an Intel Mac with macOS 15.8.1, iPhone 17 simulator (iOS 26.3) paired with an Apple Watch Series 11 simulator (watchOS 26.2). Results are recorded in `docs/IMPLEMENTATION_PLAN.md`. Nothing has run on a real iPhone or Apple Watch yet.

## 0. Prerequisites

- macOS with Xcode 26.0+ (Capacitor 8 minimum). On macOS 15.x the newest usable Xcode is 26.3 (26.4+ needs macOS 26.2); it is enough for this project (iOS 17 / watchOS 10 targets).
- Install Xcode in `/Applications` and select it: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. With only the Command Line Tools, `swift test` fails (`no such module 'XCTest'`).
- Node ≥ 24.15 (the Angular CLI refuses older 24.x), Bun 1.4.3.
- `bun install --frozen-lockfile && bun run ios:sync` (builds the web app and runs `cap sync ios`).
- Simulator builds need no signing team. A team is needed only for a real device (and the App Group must then exist in the developer portal).

## 1. Shared Swift core

```bash
cd ios/HarmoniaCore && swift test
```

Runs the shared date vectors (`shared/test-vectors/date-vectors.json`) and snapshot/privacy tests against the Swift port.

## 2. Targets (already in `ios/App/App.xcodeproj`)

| Target | Bundle id | Sources | Min OS | Embedded in |
|---|---|---|---|---|
| App | `harmonia.companion` | `App/App/` | iOS 15.0 | — |
| HarmoniaWidget | `harmonia.companion.widget` | `ios/HarmoniaWidget/` | iOS 17.0 | App › PlugIns |
| HarmoniaWatch | `harmonia.companion.watchkitapp` | `ios/HarmoniaWatch/` (generated Info.plist, `WKCompanionAppBundleIdentifier`) | watchOS 10.0 | App › Watch |
| HarmoniaWatchWidget | `harmonia.companion.watchkitapp.widget` | `ios/HarmoniaWatchWidget/` | watchOS 10.0 | HarmoniaWatch › PlugIns |

- The three extension/watch targets link the local package `ios/HarmoniaCore`; the App target does not.
- Every target declares the App Group `group.harmonia.companion` (`*.entitlements`). The watch has its own container; the iPhone sends the snapshot with WatchConnectivity.
- Automatic signing, no `DEVELOPMENT_TEAM` committed: choose your team in Signing & Capabilities for each of the four targets before running on a device.

## 3. Build and run in the simulators

```bash
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build build
```

- Pair a watch with the phone (`xcrun simctl pair <watch-udid> <phone-udid>`) and boot both.
- `simctl install` of the iPhone app does **not** install the embedded watch app on the paired watch simulator. Install it directly: `xcrun simctl install <watch-udid> build/Build/Products/Debug-iphonesimulator/App.app/Watch/HarmoniaWatch.app`.
- The watch receives the snapshot the next time the phone app writes one (each launch, or any change).
- Widgets: on the Home Screen, touch and hold the Harmonia icon and pick the small or medium size; on the Lock Screen use Customize › Add Widgets › Harmonia. Complications: edit a face with slots (e.g. Infograph) › Complications › Harmonia.

## 4. Known simulator limitation (Intel Macs)

Loading libsodium (WebAssembly) in WKWebView crashes the WebContent process on the iOS 26.3 simulator on an Intel Mac (`EXC_BAD_ACCESS` inside JavaScriptCore's `Wasm::prepareSignalingMemory` signal handler); Capacitor then reloads the page. Plain WebAssembly modules, including out-of-bounds traps, work, and the same libsodium build runs in the macOS JavaScriptCore of the same Mac. The partner-sharing crypto check in WKWebView (`__harmoniaSyncSpike.selfTest()`, `docs/PARTNER_SYNC.md` §15) must therefore run on a real iPhone or an Apple-silicon Mac.

## 5. Manual checks

- [x] `swift test` in `ios/HarmoniaCore` passes (7 tests: 26 duration + 12 annual vectors, glance/privacy/timeline).
- [x] App builds/runs; native SQLite persists across relaunch and reinstall.
- [ ] Notification permission is asked only when saving a date with reminders; reminders appear at the chosen local time (test with a near-future reminder).
- [x] Widgets: small/medium and Lock Screen circular/rectangular values, privacy change (Discreet → Everything) updates them immediately, tap opens Home. Not yet: placeholder with no profile, inline Lock Screen widget, widget configuration intent, refresh after midnight, dark mode, Dynamic Type.
- [ ] Delete all data → widgets and watch show the placeholder.
- [x] Watch app shows the phone's snapshot (and the privacy change); circular complication renders on Infograph. Not yet: corner/rectangular/inline families, fallback icon with no data, a real watch.
- [x] French and Dutch: app, watch app and the camera permission prompt (`InfoPlist.xcstrings`).
- [x] Keychain (secure storage plugin): item survives relaunch, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, not synchronisable; removal works.
- [ ] libsodium in WKWebView (see §4).
- [ ] Export share sheet saves a ZIP to Files.
