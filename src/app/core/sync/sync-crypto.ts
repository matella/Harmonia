/**
 * End-to-end encryption primitives for partner sharing (docs/PARTNER_SYNC.md §3).
 * Framework-free; libsodium is loaded on demand so solo users never download it.
 *
 * Everything here is pure and deterministic given its inputs (randomness comes from
 * libsodium's CSPRNG), so the same functions run in Node tests and in the WebViews.
 */
import type sodiumModule from 'libsodium-wrappers';

export type Sodium = typeof sodiumModule;

let loading: Promise<Sodium> | null = null;

/** Loads and initialises libsodium once. The 0.8 build is WebAssembly-only: without WASM it fails to load. */
export function loadSodium(): Promise<Sodium> {
  loading ??= import('libsodium-wrappers').then(async (module) => {
    const sodium = (module as unknown as { default?: Sodium }).default ?? (module as unknown as Sodium);
    await sodium.ready;
    return sodium;
  });
  return loading;
}

// ---------------------------------------------------------------------------------
// Device identity

export interface DeviceKeys {
  /** Ed25519: signs requests to the server. */
  signPublicKey: Uint8Array;
  signSecretKey: Uint8Array;
  /** X25519: receives sealed space keys. */
  boxPublicKey: Uint8Array;
  boxSecretKey: Uint8Array;
}

export function generateDeviceKeys(s: Sodium): DeviceKeys {
  const sign = s.crypto_sign_keypair();
  const box = s.crypto_box_keypair();
  return {
    signPublicKey: sign.publicKey,
    signSecretKey: sign.privateKey,
    boxPublicKey: box.publicKey,
    boxSecretKey: box.privateKey,
  };
}

export function signMessage(s: Sodium, message: Uint8Array, keys: Pick<DeviceKeys, 'signSecretKey'>): Uint8Array {
  return s.crypto_sign_detached(message, keys.signSecretKey);
}

export function verifySignature(s: Sodium, message: Uint8Array, signature: Uint8Array, signPublicKey: Uint8Array): boolean {
  return s.crypto_sign_verify_detached(signature, message, signPublicKey);
}

// ---------------------------------------------------------------------------------
// Space keys

export const SPACE_KEY_BYTES = 32;

export function newSpaceKey(s: Sodium): Uint8Array {
  return s.crypto_aead_xchacha20poly1305_ietf_keygen();
}

/** Seals a space key so only the holder of `boxPublicKey`'s secret can open it. */
export function sealSpaceKey(s: Sodium, spaceKey: Uint8Array, boxPublicKey: Uint8Array): Uint8Array {
  return s.crypto_box_seal(spaceKey, boxPublicKey);
}

export function openSealedSpaceKey(s: Sodium, sealed: Uint8Array, keys: Pick<DeviceKeys, 'boxPublicKey' | 'boxSecretKey'>): Uint8Array {
  return s.crypto_box_seal_open(sealed, keys.boxPublicKey, keys.boxSecretKey);
}

// ---------------------------------------------------------------------------------
// Records

export interface RecordAddress {
  spaceId: string;
  recordType: string;
  recordId: string;
  epoch: number;
  /** HLC version the server stores next to the ciphertext. */
  version: string;
  /** Tombstone flag the server stores next to the ciphertext. */
  deleted: boolean;
}

export interface EncryptedRecord {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Additional authenticated data: binds a ciphertext to its place and to the metadata the
 * server stores beside it. The server cannot move a record to another ID, type, space or
 * epoch, replay an old ciphertext under a newer version, or flip the deleted flag,
 * without decryption failing.
 */
export function recordAad(address: RecordAddress): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      'harmonia-record-v2',
      address.spaceId,
      address.recordType,
      address.recordId,
      address.epoch,
      address.version,
      address.deleted,
    ]),
  );
}

export function encryptRecord(s: Sodium, spaceKey: Uint8Array, address: RecordAddress, plaintext: string): EncryptedRecord {
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, recordAad(address), null, nonce, spaceKey);
  return { nonce, ciphertext };
}

/** Throws when the key, the address or the ciphertext does not match. */
export function decryptRecord(s: Sodium, spaceKey: Uint8Array, address: RecordAddress, record: EncryptedRecord): string {
  const plain = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, record.ciphertext, recordAad(address), record.nonce, spaceKey);
  return new TextDecoder().decode(plain);
}

// ---------------------------------------------------------------------------------
// Invites

export const INVITE_SECRET_BYTES = 32;

export function newInviteSecret(s: Sodium): Uint8Array {
  return s.randombytes_buf(INVITE_SECRET_BYTES);
}

/** Wraps the space key with a key derived from the invite secret (which never reaches the server). */
export function wrapForInvite(s: Sodium, spaceKey: Uint8Array, inviteSecret: Uint8Array): Uint8Array {
  return secretboxWrap(s, spaceKey, s.crypto_kdf_derive_from_key(32, 1, 'hminvite', inviteSecret));
}

export function unwrapInvite(s: Sodium, wrapped: Uint8Array, inviteSecret: Uint8Array): Uint8Array {
  return secretboxUnwrap(s, wrapped, s.crypto_kdf_derive_from_key(32, 1, 'hminvite', inviteSecret));
}

/** Both public keys of a device: the safety code must cover the key the space key is sealed to. */
export type DevicePublicKeys = Pick<DeviceKeys, 'signPublicKey' | 'boxPublicKey'>;

/**
 * Six digits shown on both screens before an invite is approved. Order-independent.
 * It covers both public keys of each device (a server that swaps the encryption key
 * changes the digits) and is keyed with the invite secret, which travels only in the
 * link or QR code: the server cannot compute the code, so it cannot grind key pairs
 * offline until the six digits match.
 */
export function safetyCode(
  s: Sodium,
  inviteSecret: Uint8Array,
  inviteId: string,
  deviceA: DevicePublicKeys,
  deviceB: DevicePublicKeys,
): string {
  const fingerprint = (d: DevicePublicKeys) => `${s.to_hex(d.signPublicKey)}.${s.to_hex(d.boxPublicKey)}`;
  const [first, second] = [fingerprint(deviceA), fingerprint(deviceB)].sort();
  const key = s.crypto_kdf_derive_from_key(32, 2, 'hminvite', inviteSecret);
  const digest = s.crypto_generichash(8, `harmonia-safety-v2|${inviteId}|${first}|${second}`, key);
  const value = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(0) % 1_000_000;
  return value.toString().padStart(6, '0');
}

// ---------------------------------------------------------------------------------
// Recovery key: 184 random bits + 16-bit checksum = 25 bytes = 40 Crockford base32
// characters, shown as 8 groups of 5. Language-neutral and typo-tolerant.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_RANDOM_BYTES = 23;

export function generateRecoveryKey(s: Sodium): { raw: Uint8Array; display: string } {
  const raw = s.randombytes_buf(RECOVERY_RANDOM_BYTES);
  return { raw, display: formatRecoveryKey(s, raw) };
}

export function formatRecoveryKey(s: Sodium, raw: Uint8Array): string {
  const bytes = new Uint8Array(RECOVERY_RANDOM_BYTES + 2);
  bytes.set(raw);
  bytes.set(recoveryChecksum(s, raw), RECOVERY_RANDOM_BYTES);
  const text = base32Encode(bytes);
  return text.match(/.{5}/g)!.join('-');
}

/** The raw key, or null when the text is incomplete or the checksum does not match. */
export function parseRecoveryKey(s: Sodium, text: string): Uint8Array | null {
  const normalized = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (normalized.length !== 40 || [...normalized].some((c) => !CROCKFORD.includes(c))) return null;
  const bytes = base32Decode(normalized);
  const raw = bytes.slice(0, RECOVERY_RANDOM_BYTES);
  const expected = recoveryChecksum(s, raw);
  return bytes[RECOVERY_RANDOM_BYTES] === expected[0] && bytes[RECOVERY_RANDOM_BYTES + 1] === expected[1] ? raw : null;
}

export interface RecoveryDerivation {
  /** Public lookup handle stored by the server (hex). */
  lookupId: string;
  /** Wraps the space key; never leaves the device. */
  wrapKey: Uint8Array;
}

export function deriveRecovery(s: Sodium, raw: Uint8Array): RecoveryDerivation {
  const master = s.crypto_generichash(32, raw, s.from_string('harmonia-recovery-v1'));
  return {
    lookupId: s.to_hex(s.crypto_kdf_derive_from_key(16, 1, 'hmrecovr', master)),
    wrapKey: s.crypto_kdf_derive_from_key(32, 2, 'hmrecovr', master),
  };
}

/** What the recovery key yields (§8, revised in phase 4). */
export interface RecoveryKeys {
  /** Presented to recover(); the server stores only its SHA-256. */
  lookup: Uint8Array;
  /** X25519: each epoch's key is sealed to the public half. */
  boxPublicKey: Uint8Array;
  boxSecretKey: Uint8Array;
}

export function deriveRecoveryKeys(s: Sodium, raw: Uint8Array): RecoveryKeys {
  const master = s.crypto_generichash(32, raw, s.from_string('harmonia-recovery-v2'));
  const pair = s.crypto_box_seed_keypair(s.crypto_kdf_derive_from_key(32, 3, 'hmrecovr', master));
  return {
    lookup: s.crypto_kdf_derive_from_key(16, 1, 'hmrecovr', master),
    boxPublicKey: pair.publicKey,
    boxSecretKey: pair.privateKey,
  };
}

export function wrapForRecovery(s: Sodium, spaceKey: Uint8Array, recovery: RecoveryDerivation): Uint8Array {
  return secretboxWrap(s, spaceKey, recovery.wrapKey);
}

export function unwrapRecovery(s: Sodium, wrapped: Uint8Array, recovery: RecoveryDerivation): Uint8Array {
  return secretboxUnwrap(s, wrapped, recovery.wrapKey);
}

// ---------------------------------------------------------------------------------
// Photos: per-file key, chunked secretstream (constant memory, resumable by chunk).

export const BLOB_CHUNK_BYTES = 64 * 1024;

export interface EncryptedBlob {
  fileKey: Uint8Array;
  header: Uint8Array;
  chunks: Uint8Array[];
}

export function encryptBlob(s: Sodium, data: Uint8Array, chunkBytes = BLOB_CHUNK_BYTES): EncryptedBlob {
  const fileKey = s.crypto_secretstream_xchacha20poly1305_keygen();
  const { state, header } = s.crypto_secretstream_xchacha20poly1305_init_push(fileKey);
  const chunks: Uint8Array[] = [];
  const count = Math.max(1, Math.ceil(data.length / chunkBytes));
  for (let i = 0; i < count; i++) {
    const tag =
      i === count - 1 ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    chunks.push(s.crypto_secretstream_xchacha20poly1305_push(state, data.subarray(i * chunkBytes, (i + 1) * chunkBytes), null, tag));
  }
  return { fileKey, header, chunks };
}

/** Throws on any tampering, reordering, truncation or extra chunk. */
export function decryptBlob(s: Sodium, blob: EncryptedBlob): Uint8Array {
  const state = s.crypto_secretstream_xchacha20poly1305_init_pull(blob.header, blob.fileKey);
  const parts: Uint8Array[] = [];
  let finished = false;
  for (const chunk of blob.chunks) {
    if (finished) throw new Error('Data after the final chunk');
    const result = s.crypto_secretstream_xchacha20poly1305_pull(state, chunk, null);
    if (!result) throw new Error('Chunk failed authentication');
    parts.push(result.message);
    finished = result.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  }
  if (!finished) throw new Error('Blob is truncated');
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------
// Helpers

function secretboxWrap(s: Sodium, message: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const box = s.crypto_secretbox_easy(message, nonce, key);
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return out;
}

function secretboxUnwrap(s: Sodium, wrapped: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = wrapped.subarray(0, s.crypto_secretbox_NONCEBYTES);
  return s.crypto_secretbox_open_easy(wrapped.subarray(s.crypto_secretbox_NONCEBYTES), nonce, key);
}

function recoveryChecksum(s: Sodium, raw: Uint8Array): Uint8Array {
  return s.crypto_generichash(2, raw, s.from_string('harmonia-recovery-check'));
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    value = (value << 5) | CROCKFORD.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
