import { fromBase64, toBase64 } from './encoding';

/**
 * What the invite envelope carries (§7.5, §7.6), sealed with the invite secret so the
 * server can neither read nor change it:
 *  - every epoch's space key, so a device joining after a rotation can read history;
 *  - for "add one of my devices", the person the new device is to become. The joining
 *    device accepts the server's answer only if it names that person (or, for a partner
 *    invite, the person it claimed with).
 */
export interface InviteBundle {
  keys: Map<number, Uint8Array>;
  forPerson: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeInviteBundle(bundle: InviteBundle): Uint8Array {
  const keys: Record<string, string> = {};
  for (const [epoch, key] of bundle.keys) keys[String(epoch)] = toBase64(key);
  return new TextEncoder().encode(JSON.stringify({ v: 1, keys, forPerson: bundle.forPerson }));
}

/** An older invite carried just the current key (32 bytes). Throws on anything malformed. */
export function decodeInviteBundle(bytes: Uint8Array, currentEpoch: number): InviteBundle {
  if (bytes.length === 32) return { keys: new Map([[currentEpoch, bytes]]), forPerson: null };
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    v?: unknown;
    keys?: Record<string, unknown>;
    forPerson?: unknown;
  };
  if (parsed.v !== 1 || typeof parsed.keys !== 'object' || parsed.keys === null) {
    throw new Error('Unknown invite bundle');
  }
  const keys = new Map<number, Uint8Array>();
  for (const [epoch, value] of Object.entries(parsed.keys)) {
    const key = typeof value === 'string' ? fromBase64(value) : null;
    if (!/^[1-9]\d*$/.test(epoch) || !key || key.length !== 32)
      throw new Error('Bad invite bundle');
    keys.set(Number(epoch), key);
  }
  const forPerson = parsed.forPerson ?? null;
  if (forPerson !== null && (typeof forPerson !== 'string' || !UUID.test(forPerson))) {
    throw new Error('Bad invite bundle');
  }
  if (!keys.has(currentEpoch)) throw new Error('Invite bundle without the current key');
  return { keys, forPerson };
}
