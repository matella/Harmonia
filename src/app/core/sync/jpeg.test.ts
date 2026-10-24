import { describe, expect, it } from 'vitest';

import { jpegDimensions } from './jpeg';

/** A minimal JPEG head: SOI, an APP0 segment, then a frame header of `marker`. */
function head(width: number, height: number, marker = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x06,
    0x4a,
    0x46,
    0x49,
    0x46, // APP0, 4 bytes of payload
    0xff,
    marker,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
  ]);
}

describe('jpegDimensions', () => {
  it('reads the size a JPEG declares, baseline or progressive', () => {
    expect(jpegDimensions(head(2048, 1536))).toEqual({ width: 2048, height: 1536 });
    expect(jpegDimensions(head(480, 360, 0xc2))).toEqual({ width: 480, height: 360 });
    expect(jpegDimensions(head(65535, 65535))).toEqual({ width: 65535, height: 65535 });
  });

  it('refuses anything that is not a JPEG with a frame header', () => {
    expect(jpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG
    expect(jpegDimensions(head(0, 100))).toBeNull();
    expect(jpegDimensions(head(100, 100).subarray(0, 14))).toBeNull(); // cut short
    expect(jpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
    expect(jpegDimensions(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });
});
