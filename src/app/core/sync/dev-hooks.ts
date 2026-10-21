import { createSecureKeyStore } from '../platform/secure-key-store';
import { generateDeviceKeys, loadSodium } from './sync-crypto';
import { runSyncSelfTest } from './sync-self-test';

/**
 * Development builds only (phase 0 spike): lets the WebView checks in
 * docs/PARTNER_SYNC.md §15 run on a device through DevTools. Never loaded in production.
 */
export function installSyncDevHooks(): void {
  const store = createSecureKeyStore();
  (globalThis as unknown as Record<string, unknown>)['__harmoniaSyncSpike'] = {
    selfTest: () => runSyncSelfTest(),
    /** Stores a fresh device key under `name` (or returns the one already stored). */
    storeDeviceKey: async (name: string) => {
      const s = await loadSodium();
      const existing = await store.get(name);
      if (existing) return { created: false, persistent: store.persistent, publicKey: existing.split(':')[0] };
      const keys = generateDeviceKeys(s);
      await store.set(name, `${s.to_hex(keys.signPublicKey)}:${s.to_base64(keys.signSecretKey)}`);
      return { created: true, persistent: store.persistent, publicKey: s.to_hex(keys.signPublicKey) };
    },
    removeDeviceKey: (name: string) => store.remove(name),
  };
}
