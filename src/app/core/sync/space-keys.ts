import type { SecureKeyStore } from '../platform/secure-key-store';
import { fromBase64, toBase64 } from './encoding';
import type { SpaceKeyring } from './sync-engine';

/**
 * Space keys by epoch, kept in the secure key store (never in the database or a backup).
 * Implements the engine's synchronous keyring once `load` has run.
 */
export class MissingSpaceKeyError extends Error {
  constructor() {
    super('This device has no key for the shared space.');
    this.name = 'MissingSpaceKeyError';
  }
}

const name = (spaceId: string, epoch: number) => `space.${spaceId}.${epoch}`;

export class SpaceKeys implements SpaceKeyring {
  private readonly keys = new Map<number, Uint8Array>();
  private epoch = 1;

  constructor(private readonly secrets: SecureKeyStore) {}

  /** Loads every epoch up to `epoch`; throws if the current one is missing. */
  async load(spaceId: string, epoch: number): Promise<void> {
    this.keys.clear();
    this.epoch = epoch;
    for (let e = 1; e <= epoch; e++) {
      const stored = await this.secrets.get(name(spaceId, e));
      if (stored) this.keys.set(e, fromBase64(stored));
    }
    if (!this.keys.has(epoch)) throw new MissingSpaceKeyError();
  }

  async save(spaceId: string, epoch: number, key: Uint8Array): Promise<void> {
    await this.secrets.set(name(spaceId, epoch), toBase64(key));
    this.keys.set(epoch, key);
    this.epoch = Math.max(this.epoch, epoch);
  }

  async has(spaceId: string, epoch: number): Promise<boolean> {
    return (await this.secrets.get(name(spaceId, epoch))) !== null;
  }

  async forget(spaceId: string, epoch: number): Promise<void> {
    for (let e = 1; e <= epoch; e++) await this.secrets.remove(name(spaceId, e));
    this.keys.clear();
  }

  currentEpoch(): number {
    return this.epoch;
  }

  key(epoch: number): Uint8Array | null {
    return this.keys.get(epoch) ?? null;
  }
}
