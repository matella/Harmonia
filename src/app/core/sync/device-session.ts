import type { SupabaseClient } from '@supabase/supabase-js';

import type { SecureKeyStore } from '../platform/secure-key-store';
import { fromBase64, randomBytes, sha256, toBase64, toBytea } from './encoding';
import type { DeviceKeys, SyncCrypto } from './sync-crypto-port';

/**
 * This device's identity on the sharing server (docs/PARTNER_SYNC.md §4, §17).
 *
 * - The device keys and the re-attach secret live only in the secure key store.
 * - The Supabase session (an anonymous user) is persisted in the secure store too, so a
 *   restart reuses it. If it is lost or expired, the device signs in anonymously again
 *   and re-attaches its device row with the secret, which is replaced every time.
 * - Every secret is written locally *before* the server learns about it, so a crash at
 *   any point can be recovered on the next start.
 */
export type DevicePlatform = 'android' | 'ios';

/** The Supabase auth storage interface (async). */
export interface AuthStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface ConnectedDevice {
  client: SupabaseClient;
  deviceId: string;
  keys: DeviceKeys;
}

/** The server no longer accepts this device (revoked, or its credential is gone). */
export class DeviceLostError extends Error {
  constructor() {
    super('This device is no longer registered for sharing.');
    this.name = 'DeviceLostError';
  }
}

export class DeviceSessionError extends Error {
  constructor(
    readonly step: 'signIn' | 'whoAmI' | 'register' | 'rebind',
    readonly code: string,
  ) {
    super(`Device session ${step} failed (${code})`);
    this.name = 'DeviceSessionError';
  }
}

const NAMES = {
  keys: 'device.keys',
  id: 'device.id',
  secret: 'device.secret',
  nextSecret: 'device.secret.next',
  authPrefix: 'auth.',
} as const;

interface StoredKeys {
  signPublicKey: string;
  signSecretKey: string;
  boxPublicKey: string;
  boxSecretKey: string;
}

export class DeviceSession {
  private connecting: Promise<ConnectedDevice> | null = null;
  /**
   * One client per session: several clients sharing one stored session would refresh the
   * same rotating refresh token and sign each other out.
   */
  private client: SupabaseClient | null = null;

  constructor(
    private readonly secrets: SecureKeyStore,
    private readonly crypto: SyncCrypto,
    private readonly platform: DevicePlatform,
    private readonly createClient: (storage: AuthStorage) => SupabaseClient,
  ) {}

  /** Signs in (or resumes), registers or re-attaches this device. Safe to call repeatedly. */
  connect(): Promise<ConnectedDevice> {
    // Once established, the device is reused: the client refreshes its own token, and a
    // check with the server on every call would only add requests.
    this.connecting ??= this.establish().catch((error: unknown) => {
      this.connecting = null;
      throw error;
    });
    return this.connecting;
  }

  /** Forgets the established connection, so the next `connect` checks with the server again. */
  reset(): void {
    this.connecting = null;
  }

  /** The Supabase auth session, kept in the secure store instead of localStorage. */
  authStorage(): AuthStorage {
    const prefix = NAMES.authPrefix;
    return {
      getItem: (key) => this.secrets.get(prefix + key),
      setItem: (key, value) => this.secrets.set(prefix + key, value),
      removeItem: (key) => this.secrets.remove(prefix + key),
    };
  }

  private async establish(): Promise<ConnectedDevice> {
    const { keys, created } = await this.loadOrCreateKeys();
    const client = (this.client ??= this.createClient(this.authStorage()));
    // New keys are a new device: never reuse a session that belonged to an older one.
    if (created) await client.auth.signOut({ scope: 'local' });
    await this.ensureSignedIn(client);

    const deviceId = await this.secrets.get(NAMES.id);
    if (!deviceId) return { client, keys, deviceId: await this.register(client, keys) };

    const current = await this.whoAmI(client);
    if (current === deviceId) return { client, keys, deviceId };
    if (current !== null) {
      // This session belongs to some other device row; start from a fresh anonymous user.
      await client.auth.signOut({ scope: 'local' });
      await this.ensureSignedIn(client);
    }
    await this.rebind(client, deviceId);
    return { client, keys, deviceId };
  }

  private async loadOrCreateKeys(): Promise<{ keys: DeviceKeys; created: boolean }> {
    const stored = await this.secrets.get(NAMES.keys);
    if (stored) {
      const parsed = JSON.parse(stored) as StoredKeys;
      const keys = {
        signPublicKey: fromBase64(parsed.signPublicKey),
        signSecretKey: fromBase64(parsed.signSecretKey),
        boxPublicKey: fromBase64(parsed.boxPublicKey),
        boxSecretKey: fromBase64(parsed.boxSecretKey),
      };
      return { keys, created: false };
    }
    // New keys mean a new device: forget any registration that belonged to older keys.
    for (const name of [NAMES.id, NAMES.secret, NAMES.nextSecret]) await this.secrets.remove(name);
    const keys = this.crypto.generateDeviceKeys();
    const toStore: StoredKeys = {
      signPublicKey: toBase64(keys.signPublicKey),
      signSecretKey: toBase64(keys.signSecretKey),
      boxPublicKey: toBase64(keys.boxPublicKey),
      boxSecretKey: toBase64(keys.boxSecretKey),
    };
    await this.secrets.set(NAMES.keys, JSON.stringify(toStore));
    return { keys, created: true };
  }

  private async ensureSignedIn(client: SupabaseClient): Promise<void> {
    const { data } = await client.auth.getSession();
    if (data.session) return;
    const { error } = await client.auth.signInAnonymously();
    if (error)
      throw new DeviceSessionError('signIn', error.code ?? String(error.status ?? 'unknown'));
  }

  /**
   * The device row the session acts as. If the server refuses the session itself (an
   * expired or unknown token), signs in afresh once; other failures (offline) are thrown
   * and the session is kept.
   */
  private async whoAmI(client: SupabaseClient): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      const { data, error } = await client.rpc('current_device_id');
      if (!error) return (data as string | null) ?? null;
      if (attempt > 0 || !isRefusedSession(error)) {
        throw new DeviceSessionError('whoAmI', error.code || 'network');
      }
      await client.auth.signOut({ scope: 'local' });
      await this.ensureSignedIn(client);
    }
  }

  private async register(client: SupabaseClient, keys: DeviceKeys): Promise<string> {
    const secret = await this.secretFor(NAMES.secret);
    const { data, error } = await client.rpc('register_device', {
      sign_key: toBytea(keys.signPublicKey),
      box_key: toBytea(keys.boxPublicKey),
      device_platform: this.platform,
      credential: toBytea(await sha256(secret)),
    });
    if (error || typeof data !== 'string') {
      throw new DeviceSessionError('register', error?.code ?? 'unknown');
    }
    await this.secrets.set(NAMES.id, data);
    return data;
  }

  /**
   * Proves the current secret and installs the next one. If an earlier attempt reached the
   * server but not the secure store, the pending secret is already the server's: promote
   * it and try once more.
   */
  private async rebind(client: SupabaseClient, deviceId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await this.secrets.get(NAMES.secret);
      if (!current) throw new DeviceLostError();
      const next = await this.secretFor(NAMES.nextSecret);
      const { error } = await client.rpc('rebind_device', {
        device: deviceId,
        secret: toBytea(fromBase64(current)),
        next_credential: toBytea(await sha256(next)),
      });
      if (!error) {
        await this.promoteNextSecret(next);
        return;
      }
      if (!/not allowed/.test(error.message ?? '')) {
        throw new DeviceSessionError('rebind', error.code ?? 'unknown');
      }
      if (attempt === 0) await this.promoteNextSecret(next);
    }
    throw new DeviceLostError();
  }

  private async promoteNextSecret(next: Uint8Array): Promise<void> {
    await this.secrets.set(NAMES.secret, toBase64(next));
    await this.secrets.remove(NAMES.nextSecret);
  }

  /** The secret stored under `name`, created and stored first if missing. */
  private async secretFor(name: string): Promise<Uint8Array> {
    const stored = await this.secrets.get(name);
    if (stored) return fromBase64(stored);
    const fresh = randomBytes(32);
    await this.secrets.set(name, toBase64(fresh));
    return fresh;
  }
}

/** PostgREST's JWT errors (PGRST301–303), or a message about the JWT. */
function isRefusedSession(error: { code?: string; message?: string }): boolean {
  return /^PGRST30[1-3]$/.test(error.code ?? '') || /\bJWT\b/i.test(error.message ?? '');
}
