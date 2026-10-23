import * as impl from './sync-crypto';
import type {
  DeviceKeys,
  DevicePublicKeys,
  EncryptedBlob,
  EncryptedRecord,
  RecordAddress,
  RecoveryDerivation,
  RecoveryKeys,
} from './sync-crypto';

export type {
  RecoveryKeys,
  DeviceKeys,
  DevicePublicKeys,
  EncryptedBlob,
  EncryptedRecord,
  RecordAddress,
  RecoveryDerivation,
};

/**
 * Every cryptographic operation partner sharing needs (docs/PARTNER_SYNC.md §3), behind
 * one interface. The sync engine and UI depend only on this, so the backing library can
 * change in one place — libsodium today; a pure-JS implementation (e.g. noble) if
 * WebAssembly ever proves unreliable on real devices (§15).
 */
export interface SyncCrypto {
  readonly backend: string;
  generateDeviceKeys(): DeviceKeys;
  sign(message: Uint8Array, keys: Pick<DeviceKeys, 'signSecretKey'>): Uint8Array;
  verify(message: Uint8Array, signature: Uint8Array, signPublicKey: Uint8Array): boolean;

  newSpaceKey(): Uint8Array;
  sealSpaceKey(spaceKey: Uint8Array, boxPublicKey: Uint8Array): Uint8Array;
  openSealedSpaceKey(
    sealed: Uint8Array,
    keys: Pick<DeviceKeys, 'boxPublicKey' | 'boxSecretKey'>,
  ): Uint8Array;

  encryptRecord(spaceKey: Uint8Array, address: RecordAddress, plaintext: string): EncryptedRecord;
  /** Throws when the key, the address (incl. version and tombstone) or the ciphertext does not match. */
  decryptRecord(spaceKey: Uint8Array, address: RecordAddress, record: EncryptedRecord): string;

  newInviteSecret(): Uint8Array;
  wrapForInvite(spaceKey: Uint8Array, inviteSecret: Uint8Array): Uint8Array;
  unwrapInvite(wrapped: Uint8Array, inviteSecret: Uint8Array): Uint8Array;
  safetyCode(
    inviteSecret: Uint8Array,
    inviteId: string,
    a: DevicePublicKeys,
    b: DevicePublicKeys,
  ): string;

  generateRecoveryKey(): { raw: Uint8Array; display: string };
  parseRecoveryKey(text: string): Uint8Array | null;
  deriveRecovery(raw: Uint8Array): RecoveryDerivation;
  /** Lookup and key pair from a recovery key (§8); seal with `sealSpaceKey`. */
  deriveRecoveryKeys(raw: Uint8Array): RecoveryKeys;
  wrapForRecovery(spaceKey: Uint8Array, recovery: RecoveryDerivation): Uint8Array;
  unwrapRecovery(wrapped: Uint8Array, recovery: RecoveryDerivation): Uint8Array;

  encryptBlob(data: Uint8Array): EncryptedBlob;
  decryptBlob(blob: EncryptedBlob): Uint8Array;
}

/** The libsodium-backed implementation (WebAssembly, loaded on demand). */
export async function loadSyncCrypto(): Promise<SyncCrypto> {
  const s = await impl.loadSodium();
  return {
    backend: 'libsodium',
    generateDeviceKeys: () => impl.generateDeviceKeys(s),
    sign: (message, keys) => impl.signMessage(s, message, keys),
    verify: (message, signature, key) => impl.verifySignature(s, message, signature, key),
    newSpaceKey: () => impl.newSpaceKey(s),
    sealSpaceKey: (key, pub) => impl.sealSpaceKey(s, key, pub),
    openSealedSpaceKey: (sealed, keys) => impl.openSealedSpaceKey(s, sealed, keys),
    encryptRecord: (key, address, plaintext) => impl.encryptRecord(s, key, address, plaintext),
    decryptRecord: (key, address, record) => impl.decryptRecord(s, key, address, record),
    newInviteSecret: () => impl.newInviteSecret(s),
    wrapForInvite: (key, secret) => impl.wrapForInvite(s, key, secret),
    unwrapInvite: (wrapped, secret) => impl.unwrapInvite(s, wrapped, secret),
    safetyCode: (secret, inviteId, a, b) => impl.safetyCode(s, secret, inviteId, a, b),
    generateRecoveryKey: () => impl.generateRecoveryKey(s),
    parseRecoveryKey: (text) => impl.parseRecoveryKey(s, text),
    deriveRecovery: (raw) => impl.deriveRecovery(s, raw),
    deriveRecoveryKeys: (raw) => impl.deriveRecoveryKeys(s, raw),
    wrapForRecovery: (key, recovery) => impl.wrapForRecovery(s, key, recovery),
    unwrapRecovery: (wrapped, recovery) => impl.unwrapRecovery(s, wrapped, recovery),
    encryptBlob: (data) => impl.encryptBlob(s, data),
    decryptBlob: (blob) => impl.decryptBlob(s, blob),
  };
}
