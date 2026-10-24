/**
 * The width and height a JPEG declares in its frame header, read without decoding it, or
 * null when the bytes aren't a JPEG this app could have made. A received photo is checked
 * with this before the image decoder sees it (docs/PARTNER_SYNC.md §18): a small file
 * declaring a huge image could otherwise exhaust memory on every sync.
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++; // fill byte
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end, or image data before a frame
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) return null;
    // Start of frame: baseline, extended or progressive (the encoders we use).
    if (marker >= 0xc0 && marker <= 0xc2) {
      if (offset + 9 > bytes.length) return null;
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** Shared photos are at most 2048 px on their long edge; some room for other encoders. */
export const MAX_RECEIVED_PHOTO_EDGE = 4096;
