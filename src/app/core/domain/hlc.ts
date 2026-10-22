/**
 * Hybrid logical clock for record versions (docs/PARTNER_SYNC.md §5).
 *
 * Format `MMMMMMMMMMMMM-CCCCCC-NNNNNNNN`: 13-digit milliseconds, 6-digit counter and an
 * 8-hex device node. It is fixed-width, so plain string comparison equals causal order,
 * and it matches the server's check `^[0-9]{13}-[0-9]{6}-[0-9a-f]{8}$`.
 *
 * Versions never go backwards: if the device clock jumps back, the previous wall time is
 * kept and the counter advances. Time comes only from the caller (an injected Clock).
 */
export type Hlc = string;

export const HLC_PATTERN = /^[0-9]{13}-[0-9]{6}-[0-9a-f]{8}$/;

/** Older than any real version; given to rows that existed before versioning. */
export const ZERO_HLC: Hlc = '0000000000000-000000-00000000';

const MAX_COUNTER = 999_999;

/**
 * How far ahead of this device's clock a version from another device may be. Anything
 * further is a broken clock (or a hostile writer): observing it would drag every later
 * local version into the future, so that normal edits elsewhere could never win again.
 */
export const MAX_FUTURE_DRIFT_MS = 24 * 60 * 60 * 1000;
const MAX_MS = 9_999_999_999_999;

export interface HlcParts {
  ms: number;
  counter: number;
  node: string;
}

export function formatHlc({ ms, counter, node }: HlcParts): Hlc {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_MS) throw new RangeError('HLC time out of range');
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER)
    throw new RangeError('HLC counter out of range');
  if (!/^[0-9a-f]{8}$/.test(node)) throw new RangeError('HLC node must be 8 lowercase hex digits');
  return `${String(ms).padStart(13, '0')}-${String(counter).padStart(6, '0')}-${node}`;
}

export function parseHlc(value: Hlc): HlcParts {
  if (!HLC_PATTERN.test(value)) throw new RangeError(`Not an HLC: ${value}`);
  const [ms, counter, node] = value.split('-');
  return { ms: Number(ms), counter: Number(counter), node };
}

export function compareHlc(a: Hlc, b: Hlc): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The version for a local change. `last` is the previous version issued on this device
 * (or observed from another one). The counter carries over into the next millisecond
 * rather than overflowing.
 */
export function tickHlc(last: Hlc | null, nowMs: number, node: string): Hlc {
  const previous = last ? parseHlc(last) : null;
  let ms = Math.max(Math.floor(nowMs), previous?.ms ?? 0);
  let counter = previous && ms === previous.ms ? previous.counter + 1 : 0;
  if (counter > MAX_COUNTER) {
    ms += 1;
    counter = 0;
  }
  return formatHlc({ ms, counter, node });
}

export function isTooFarAhead(version: Hlc, nowMs: number): boolean {
  return parseHlc(version).ms > Math.floor(nowMs) + MAX_FUTURE_DRIFT_MS;
}

/**
 * Folds a version received from another device into the local clock (Lamport rule). A
 * version too far ahead of `nowMs` is ignored rather than adopted.
 */
export function observeHlc(last: Hlc | null, remote: Hlc, nowMs: number, node: string): Hlc {
  if (isTooFarAhead(remote, nowMs)) return tickHlc(last, nowMs, node);
  const latest = last && compareHlc(last, remote) > 0 ? last : remote;
  return tickHlc(latest, nowMs, node);
}

/** A random 8-hex node ID (Web Crypto; no libsodium in the persistence path). */
export function newHlcNode(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
