import { Capacitor } from '@capacitor/core';

/**
 * Storage for sharing secrets (device keys, space keys) — docs/PARTNER_SYNC.md §3.
 *
 * Native: @aparajita/capacitor-secure-storage. On iOS, Keychain items are
 * `whenUnlockedThisDeviceOnly` and never synchronised to iCloud, so they neither leave
 * the device nor migrate through a backup. On Android, values are AES-GCM encrypted with
 * a key held in the Android Keystore, in app-private preferences that are excluded from
 * backups (data_extraction_rules.xml, allowBackup=false).
 *
 * The browser preview keeps secrets in memory only: the plugin's own web fallback uses
 * localStorage, which is not acceptable for keys. Sharing is a native-only feature.
 */
export interface SecureKeyStore {
  readonly persistent: boolean;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

const PREFIX = 'harmonia.sync.';

class NativeSecureKeyStore implements SecureKeyStore {
  readonly persistent = true;
  private ready: Promise<typeof import('@aparajita/capacitor-secure-storage')> | null = null;

  private plugin() {
    this.ready ??= import('@aparajita/capacitor-secure-storage').then(async (module) => {
      await module.SecureStorage.setKeyPrefix(PREFIX);
      await module.SecureStorage.setSynchronize(false);
      await module.SecureStorage.setDefaultKeychainAccess(module.KeychainAccess.whenUnlockedThisDeviceOnly);
      return module;
    });
    return this.ready;
  }

  async get(name: string): Promise<string | null> {
    const { SecureStorage } = await this.plugin();
    return SecureStorage.getItem(name);
  }

  async set(name: string, value: string): Promise<void> {
    const { SecureStorage } = await this.plugin();
    await SecureStorage.setItem(name, value);
  }

  async remove(name: string): Promise<void> {
    const { SecureStorage } = await this.plugin();
    await SecureStorage.removeItem(name);
  }
}

/** Not persisted, never written to localStorage or IndexedDB. */
export class MemorySecureKeyStore implements SecureKeyStore {
  readonly persistent = false;
  private readonly values = new Map<string, string>();

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async remove(name: string): Promise<void> {
    this.values.delete(name);
  }
}

export function createSecureKeyStore(): SecureKeyStore {
  return Capacitor.isNativePlatform() ? new NativeSecureKeyStore() : new MemorySecureKeyStore();
}
