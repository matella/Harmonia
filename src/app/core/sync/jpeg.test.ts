import { describe, expect, it } from 'vitest';

import { jpegDimensions } from './jpeg';

const SOI = [0xff, 0xd8];
const APP0 = [0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46];
const SOS = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
const frame = (width: number, height: number, marker = 0xc0) => [
  0xff,
  marker,
  0x00,
  0x0b,
  0x08,
  height >> 8,
  height & 0xff,
  width >> 8,
  width & 0xff,
  0x01,
  0x01,
  0x11,
  0x00,
];
const jpeg = (...parts: number[][]) => new Uint8Array(parts.flat());

describe('jpegDimensions', () => {
  it('reads the size a JPEG declares, baseline or progressive', () => {
    expect(jpegDimensions(jpeg(SOI, APP0, frame(2048, 1536), SOS))).toEqual({
      width: 2048,
      height: 1536,
    });
    expect(jpegDimensions(jpeg(SOI, frame(480, 360, 0xc2), SOS))).toEqual({
      width: 480,
      height: 360,
    });
    expect(jpegDimensions(jpeg(SOI, frame(65535, 65535), SOS))).toEqual({
      width: 65535,
      height: 65535,
    });
  });

  it('reads it the way a decoder would: the first frame header, and only one', () => {
    // A frame header of another kind first (lossless, arithmetic…), small one later: refused.
    for (const marker of [0xc3, 0xc5, 0xc9, 0xcb, 0xcd, 0xcf]) {
      expect(
        jpegDimensions(jpeg(SOI, frame(60000, 60000, marker), frame(100, 100), SOS)),
        marker.toString(16),
      ).toBeNull();
    }
    expect(jpegDimensions(jpeg(SOI, frame(100, 100), frame(60000, 60000), SOS))).toBeNull();
    // Tables that share the range aren't frame headers.
    const dht = [0xff, 0xc4, 0x00, 0x03, 0x00];
    expect(jpegDimensions(jpeg(SOI, dht, frame(640, 480), SOS))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('refuses anything that is not a JPEG with a frame header before its image data', () => {
    expect(jpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG
    expect(jpegDimensions(jpeg(SOI, frame(0, 100), SOS))).toBeNull();
    expect(jpegDimensions(jpeg(SOI, frame(100, 100)))).toBeNull(); // no image data
    expect(jpegDimensions(jpeg(SOI, frame(100, 100)).subarray(0, 8))).toBeNull(); // cut short
    expect(jpegDimensions(jpeg(SOI, SOS, frame(100, 100)))).toBeNull(); // data before the frame
    expect(jpegDimensions(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });
});
