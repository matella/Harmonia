import type { SecureKeyStore } from '../platform/secure-key-store';
import { fromBase64, toBase64 } from './encoding';
import { spaceKeyName } from './secret-names';
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

const name = spaceKeyName;

/**
 * What a device signs when it files a space key sealed to itself: the envelope's place
 * and contents. A device trusts an envelope from the server only with its own valid
 * signature, so the server cannot plant a key it knows (§17).
 */
export function envelopeMessage(
  spaceId: string,
  epoch: number,
  deviceId: string,
  sealed: Uint8Array,
): Uint8Array {
  const head = new TextEncoder().encode(
    ['harmonia.envelope.v1', spaceId, String(epoch), deviceId, ''].join('\u0000'),
  );
  const message = new Uint8Array(head.length + sealed.length);
  message.set(head, 0);
  message.set(sealed, head.length);
  return message;
}

/**
 * What the sealing device signs for a recovery envelope (§8): the same layout as a device
 * envelope, addressed to the person instead. Device IDs are UUIDs, so this can't collide.
 */
export function recoveryEnvelopeMessage(
  spaceId: string,
  epoch: number,
  personId: string,
  sealed: Uint8Array,
): Uint8Array {
  return envelopeMessage(spaceId, epoch, `recovery:${personId}`, sealed);
}

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

  /**
   * Empty, with no epoch: until keys are saved, a pull waits at every record instead of
   * skipping it as older than the current epoch (used when recovering, §8).
   */
  reset(): void {
    this.keys.clear();
    this.epoch = 0;
  }

  currentEpoch(): number {
    return this.epoch;
  }

  key(epoch: number): Uint8Array | null {
    return this.keys.get(epoch) ?? null;
  }
}
