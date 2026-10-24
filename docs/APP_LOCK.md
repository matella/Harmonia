# App lock

Decided by the product owner (2026-10-24): **phone unlock**. Harmonia keeps no PIN of its own; it uses the phone's own unlock: fingerprint or face, falling back to the phone's PIN, pattern, password or passcode.

## Behaviour
- **Settings › Privacy and data › App lock**: *Lock Harmonia*, off by default.
  - It is offered only when the phone has a screen lock; otherwise the hint says to set one first.
  - Turning it on asks to unlock once, so nobody locks themselves out by mistake. A cancel or a failure leaves it off.
- **Lock after**: right away, or after 1, 5 or 15 minutes in the background (default 1 minute).
- Harmonia **starts locked**, and locks again when it comes back after the chosen time. A clock that went backwards locks too.
- The **lock screen** covers everything, and the app under it is inert (not reachable by touch or screen reader). Locking closes any open dialog first (dialogs sit outside the part made inert).
- As soon as the app leaves the foreground with the lock on, a plain cover hides it; on return it becomes the lock screen, or goes away if the lock isn't due yet. The phone's unlock prompt opens by itself, once; after a cancel, *Unlock* opens it again.
- The phone's own PIN screen sends the app to the background and back while unlocking; that pause doesn't count.
- **Widgets and the watch** keep showing what their own privacy setting allows (Settings › Widgets and watch). Notifications follow their own setting too.

## Implementation
- `core/platform/app-lock.ts`: the port. `BiometricAppLock` uses `@aparajita/capacitor-biometric-auth` (Android BiometricPrompt with device credential, iOS LocalAuthentication), loaded on use. `NoAppLock` in the browser preview, where no lock is offered.
- `core/domain/app-lock.ts`: when to lock on resume (framework-free, tested).
- `core/services/app-lock.service.ts`: the state; set at startup before anything renders, then on pause and resume from `LifecycleService`.
- `features/lock/lock-screen.component.ts`, shown by the app root.
- Settings `appLock` and `appLockAfter` (validated; no migration needed).
- iOS: `NSFaceIDUsageDescription` in `Info.plist`, translated in `InfoPlist.xcstrings` (EN/FR/NL).

## Verified
- Unit and spec tests: the timing rule; the service (starts locked, locks only after the delay, a cancel keeps it locked, the PIN screen's own pause is ignored, enabling needs one unlock and a screen lock); settings validation.
- **Android emulator** (API 37.2, a PIN set with `adb shell locksettings set-pin`):
  - turning it on opened the system prompt, which unlocked with the PIN;
  - with *Right away*, going home and back showed the lock screen and the prompt;
  - cancelling left the lock screen; *Unlock* and the PIN opened the app on the same screen;
  - a cold start opened locked, with the content inert.
- Not verified: fingerprint or face (none enrolled on the emulator), iOS and Face ID, a real phone.

## Not covered
- The app switcher's thumbnail: the app covers itself with a plain screen as soon as it leaves the foreground (with the lock on), so the thumbnail and the first frame on return normally show nothing. This is best effort: if the system takes the thumbnail before the cover is drawn, it can show the last screen. Android `FLAG_SECURE` would close that gap, but would also block the user's own screenshots of the app.
- A stolen phone whose screen lock is known: the app lock adds nothing then.
