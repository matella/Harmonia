/**
 * The width and height a JPEG declares in its frame header, read without decoding it, or
 * null when the bytes aren't a JPEG this app could have made. A received photo is checked
 * with this before the image decoder sees it (docs/PARTNER_SYNC.md §18): a small file
 * declaring a huge image could otherwise exhaust memory on every sync.
 *
 * Read the way a decoder would, so the two can't disagree: every frame header counts
 * (not only the kinds our encoders write); only baseline, extended and progressive ones
 * are accepted, and exactly one may come before the image data.
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let frame: { width: number; height: number } | null = null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++; // fill byte
      continue;
    }
    if (marker === 0xda) return frame; // start of scan: the frame header must be known by now
    if (marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (isFrameHeader(marker)) {
      if (frame || marker > 0xc2 || length < 7) return null; // a second one, or a kind we don't make
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      if (width === 0 || height === 0) return null;
      frame = { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

/** SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range. */
function isFrameHeader(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Shared photos are at most 2048 px on their long edge; some room for other encoders. */
export const MAX_RECEIVED_PHOTO_EDGE = 4096;
