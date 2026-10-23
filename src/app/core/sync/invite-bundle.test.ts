import { describe, expect, it } from 'vitest';

import { decodeInviteBundle, encodeInviteBundle } from './invite-bundle';

describe('invite bundle', () => {
  const k1 = new Uint8Array(32).fill(1);
  const k2 = new Uint8Array(32).fill(2);
  const person = '0f1e2d3c-4b5a-4968-8776-655443322110';

  it('carries every epoch and the person for one of my devices', () => {
    const bundle = {
      keys: new Map([
        [1, k1],
        [2, k2],
      ]),
      forPerson: person,
    };
    expect(decodeInviteBundle(encodeInviteBundle(bundle), 2)).toEqual(bundle);
  });

  it('reads an older invite that carried only the current key', () => {
    expect(decodeInviteBundle(k2, 3)).toEqual({ keys: new Map([[3, k2]]), forPerson: null });
  });

  it('refuses anything malformed or without the current key', () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    for (const bad of [
      encode({ v: 2, keys: {} }),
      encode({ v: 1, keys: { '1': 'short' } }),
      encode({ v: 1, keys: { x: Buffer.from(k1).toString('base64') } }),
      encode({ v: 1, keys: { '1': Buffer.from(k1).toString('base64') }, forPerson: 'robert' }),
      encode({ v: 1, keys: { '1': Buffer.from(k1).toString('base64') } }), // current is 2
    ]) {
      expect(() => decodeInviteBundle(bad, 2)).toThrow();
    }
  });
});
