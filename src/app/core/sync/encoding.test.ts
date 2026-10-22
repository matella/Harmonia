import { describe, expect, it } from 'vitest';

import { fromBase64, fromBytea, sha256, toBase64, toBytea } from './encoding';

describe('sharing byte encodings', () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);

  it('round-trips base64 and Postgres bytea hex', () => {
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toBytea(bytes)).toBe('\\x00017f80feff');
    expect(fromBytea('\\x00017F80FEFF')).toEqual(bytes);
    expect(fromBytea('\\x')).toEqual(new Uint8Array(0));
  });

  it('refuses values that are not bytea', () => {
    for (const bad of ['00ff', '\\x0', '\\xzz', 42, null]) expect(() => fromBytea(bad)).toThrow();
  });

  it('hashes with SHA-256', async () => {
    const digest = await sha256(new TextEncoder().encode('abc'));
    expect(toBytea(digest)).toBe(
      '\\xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
