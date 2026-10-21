import {
  decryptBlob,
  decryptRecord,
  deriveRecovery,
  encryptBlob,
  encryptRecord,
  generateDeviceKeys,
  generateRecoveryKey,
  loadSodium,
  newInviteSecret,
  newSpaceKey,
  openSealedSpaceKey,
  parseRecoveryKey,
  safetyCode,
  sealSpaceKey,
  signMessage,
  unwrapInvite,
  unwrapRecovery,
  verifySignature,
  wrapForInvite,
  wrapForRecovery,
} from './sync-crypto';

export interface SyncSelfTestReport {
  ok: boolean;
  /** libsodium 0.8 ships only a WebAssembly build, so a successful load means WASM. */
  backend: 'wasm';
  checks: Record<string, boolean>;
  /** Milliseconds for the slow-path operations, to size the UX. */
  timings: Record<string, number>;
}

/**
 * End-to-end round trip of every primitive in docs/PARTNER_SYNC.md §3 (phase 0 spike).
 * Runs in Node tests and, in development builds, inside the app's WebView.
 */
export async function runSyncSelfTest(now: () => number = () => performance.now()): Promise<SyncSelfTestReport> {
  const timings: Record<string, number> = {};
  const time = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const start = now();
    const result = await fn();
    timings[name] = Math.round((now() - start) * 10) / 10;
    return result;
  };
  const s = await time('load', loadSodium);
  const checks: Record<string, boolean> = {};

  const alice = await time('deviceKeys', () => generateDeviceKeys(s));
  const bob = generateDeviceKeys(s);
  const spaceKey = newSpaceKey(s);

  checks['sealedKeyRoundTrip'] = equal(openSealedSpaceKey(s, sealSpaceKey(s, spaceKey, bob.boxPublicKey), bob), spaceKey);
  checks['sealedKeyWrongDevice'] = throws(() => openSealedSpaceKey(s, sealSpaceKey(s, spaceKey, bob.boxPublicKey), alice));

  const address = { spaceId: 'space-1', recordType: 'milestone', recordId: 'm-1', epoch: 1 };
  const plaintext = JSON.stringify({ title: 'Notre anniversaire 💞', eventDate: '2024-06-14' });
  const record = encryptRecord(s, spaceKey, address, plaintext);
  checks['recordRoundTrip'] = decryptRecord(s, spaceKey, address, record) === plaintext;
  checks['recordMovedIsRejected'] = throws(() => decryptRecord(s, spaceKey, { ...address, recordId: 'm-2' }, record));
  checks['recordOtherEpochIsRejected'] = throws(() => decryptRecord(s, spaceKey, { ...address, epoch: 2 }, record));
  checks['recordWrongKeyIsRejected'] = throws(() => decryptRecord(s, newSpaceKey(s), address, record));

  const message = s.from_string('POST /records 1792317600');
  const signature = signMessage(s, message, alice);
  checks['signatureVerifies'] = verifySignature(s, message, signature, alice.signPublicKey);
  checks['signatureWrongKey'] = !verifySignature(s, message, signature, bob.signPublicKey);

  const secret = newInviteSecret(s);
  checks['inviteRoundTrip'] = equal(unwrapInvite(s, wrapForInvite(s, spaceKey, secret), secret), spaceKey);
  checks['inviteWrongSecret'] = throws(() => unwrapInvite(s, wrapForInvite(s, spaceKey, secret), newInviteSecret(s)));
  const codeA = safetyCode(s, 'invite-1', alice.signPublicKey, bob.signPublicKey);
  checks['safetyCodeSymmetric'] = codeA === safetyCode(s, 'invite-1', bob.signPublicKey, alice.signPublicKey) && /^\d{6}$/.test(codeA);
  checks['safetyCodeDetectsSwap'] = codeA !== safetyCode(s, 'invite-1', alice.signPublicKey, generateDeviceKeys(s).signPublicKey);

  const recovery = generateRecoveryKey(s);
  const parsed = parseRecoveryKey(s, recovery.display.toLowerCase().replace(/0/g, 'o'));
  checks['recoveryFormat'] = /^([0-9A-HJKMNP-TV-Z]{5}-){7}[0-9A-HJKMNP-TV-Z]{5}$/.test(recovery.display);
  checks['recoveryParsesTolerantly'] = parsed !== null && equal(parsed, recovery.raw);
  const typo = recovery.display.slice(0, 3) + (recovery.display[3] === 'A' ? 'B' : 'A') + recovery.display.slice(4);
  checks['recoveryDetectsTypo'] = parseRecoveryKey(s, typo) === null;
  const derivation = deriveRecovery(s, recovery.raw);
  checks['recoveryRoundTrip'] = equal(unwrapRecovery(s, wrapForRecovery(s, spaceKey, derivation), deriveRecovery(s, parsed!)), spaceKey);
  checks['recoveryLookupStable'] = derivation.lookupId === deriveRecovery(s, recovery.raw).lookupId && derivation.lookupId.length === 32;

  const photo = s.randombytes_buf(1_500_000);
  const blob = await time('encrypt1.5MB', () => encryptBlob(s, photo));
  const restored = await time('decrypt1.5MB', () => decryptBlob(s, blob));
  checks['blobRoundTrip'] = equal(restored, photo) && blob.chunks.length === Math.ceil(photo.length / (64 * 1024));
  checks['blobTruncationRejected'] = throws(() => decryptBlob(s, { ...blob, chunks: blob.chunks.slice(0, -1) }));
  checks['blobReorderRejected'] = throws(() => decryptBlob(s, { ...blob, chunks: [blob.chunks[1], blob.chunks[0], ...blob.chunks.slice(2)] }));
  const tampered = blob.chunks.map((c) => c.slice());
  tampered[3][10] ^= 1;
  checks['blobTamperRejected'] = throws(() => decryptBlob(s, { ...blob, chunks: tampered }));

  return { ok: Object.values(checks).every(Boolean), backend: 'wasm', checks, timings };
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
