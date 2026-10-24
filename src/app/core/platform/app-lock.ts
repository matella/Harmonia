import { Capacitor } from '@capacitor/core';

/** What the system unlock prompt says. */
export interface AppLockTexts {
  title: string;
  reason: string;
  cancel: string;
}

export type UnlockResult = 'unlocked' | 'cancelled' | 'failed';

/**
 * The phone's own unlock (docs/APP_LOCK.md): fingerprint or face, falling back to the
 * phone's PIN, pattern, password or passcode. Harmonia keeps no code of its own.
 */
export interface AppLockPort {
  /** Whether the phone itself has a screen lock; without one there is nothing to unlock with. */
  deviceIsSecure(): Promise<boolean>;
  unlock(texts: AppLockTexts): Promise<UnlockResult>;
}

/** The browser preview: no lock to offer. */
export class NoAppLock implements AppLockPort {
  async deviceIsSecure(): Promise<boolean> {
    return false;
  }

  async unlock(): Promise<UnlockResult> {
    return 'failed';
  }
}

/** Android BiometricPrompt and iOS LocalAuthentication, through the plugin (loaded on use). */
export class BiometricAppLock implements AppLockPort {
  private readonly plugin = () => import('@aparajita/capacitor-biometric-auth');

  async deviceIsSecure(): Promise<boolean> {
    try {
      const { BiometricAuth } = await this.plugin();
      return (await BiometricAuth.checkBiometry()).deviceIsSecure;
    } catch {
      return false;
    }
  }

  async unlock(texts: AppLockTexts): Promise<UnlockResult> {
    const { BiometricAuth, AndroidBiometryStrength } = await this.plugin();
    try {
      await BiometricAuth.authenticate({
        reason: texts.reason,
        cancelTitle: texts.cancel,
        allowDeviceCredential: true,
        androidTitle: texts.title,
        androidSubtitle: texts.reason,
        androidConfirmationRequired: false,
        androidBiometryStrength: AndroidBiometryStrength.weak,
      });
      return 'unlocked';
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return code === 'userCancel' || code === 'appCancel' || code === 'systemCancel'
        ? 'cancelled'
        : 'failed';
    }
  }
}

export function createAppLockPort(): AppLockPort {
  return Capacitor.isNativePlatform() ? new BiometricAppLock() : new NoAppLock();
}
