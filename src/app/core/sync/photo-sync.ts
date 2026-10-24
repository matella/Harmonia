import { newId } from '../persistence/ids';
import { fromBase64, toBase64 } from './encoding';
import { PhotoStorageFullError, type PhotoTransport } from './photo-transport';
import type { SyncCrypto } from './sync-crypto-port';
import type { PhotoRef, SyncStore } from './sync-store';

/**
 * Photos of shared memories (docs/PARTNER_SYNC.md §18). Each photo is encrypted with its
 * own key in 64 KiB chunks; 16 chunks make one stored part (1 MiB of plaintext). A photo
 * goes up before its record, which carries the key; another device downloads and checks
 * every chunk before it keeps the file.
 *
 * libsodium's chunked encryption picks a new random header each time, so a half-uploaded
 * photo can't be re-encrypted to match the parts already stored. An interrupted photo
 * therefore starts again (its stale parts deleted, the same reservation reused); an
 * interrupted batch carries on with the photos that remain.
 */
export const PART_PLAINTEXT_BYTES = 1024 * 1024;
const CHUNK_PLAINTEXT_BYTES = 64 * 1024;
const CHUNK_OVERHEAD_BYTES = 17; // crypto_secretstream_xchacha20poly1305_ABYTES
const CHUNKS_PER_PART = PART_PLAINTEXT_BYTES / CHUNK_PLAINTEXT_BYTES;

/** Local photo files, behind the platform (a web fallback exists for the preview). */
export interface PhotoFiles {
  read(path: string): Promise<Uint8Array | null>;
  /** Stores a downloaded photo as-is and makes this device's thumbnail. Throws if it isn't an image. */
  saveDownloaded(bytes: Uint8Array): Promise<{ filePath: string; thumbnailPath: string | null }>;
}

export interface PhotoReport {
  uploaded: number;
  downloaded: number;
  /** Photos of this device not shared yet (offline, failed, or no room). */
  waiting: number;
  /** The space is at its limit: new photos stay on this device. */
  storageFull: boolean;
}

export class PhotoSync {
  constructor(
    private readonly store: SyncStore,
    private readonly crypto: SyncCrypto,
    private readonly transport: PhotoTransport,
    private readonly files: PhotoFiles,
  ) {}

  /** Uploads this device's photos not on the server yet. */
  async upload(spaceId: string): Promise<Omit<PhotoReport, 'downloaded'>> {
    const pending = await this.store.photosToUpload();
    let uploaded = 0;
    let storageFull = false;
    for (const photo of pending) {
      try {
        await this.uploadOne(spaceId, photo);
        uploaded++;
      } catch (error) {
        if (error instanceof PhotoStorageFullError) {
          storageFull = true;
          break;
        }
        // Offline or refused: tried again on the next sync.
      }
    }
    return { uploaded, waiting: pending.length - uploaded, storageFull };
  }

  /**
   * Frees the server space of photos deleted for good, once their purge is on the server
   * (freed earlier, a crash could leave the partner a photo whose file is gone). Returns
   * how many were freed; the rest are tried again next time.
   */
  async release(spaceId: string): Promise<number> {
    let released = 0;
    for (const blobId of await this.store.blobsToRelease()) {
      try {
        await this.transport.removeParts(spaceId, blobId);
        await this.transport.release(blobId);
        await this.store.blobReleased(blobId);
        released++;
      } catch {
        // Offline: next time.
      }
    }
    return released;
  }

  /** Downloads photos from the space that aren't on this device yet. */
  async download(spaceId: string): Promise<number> {
    let downloaded = 0;
    for (const photo of await this.store.photosToDownload()) {
      try {
        const parts = Math.ceil(photo.size / PART_PLAINTEXT_BYTES);
        const chunks: Uint8Array[] = [];
        for (let part = 0; part < parts; part++) {
          chunks.push(...splitPart(await this.transport.download(spaceId, photo.blobId, part)));
        }
        const bytes = this.crypto.decryptBlob({
          fileKey: fromBase64(photo.key),
          header: fromBase64(photo.header),
          chunks,
        });
        if (bytes.length !== photo.size) throw new Error('Wrong size');
        const saved = await this.files.saveDownloaded(bytes);
        await this.store.setPhotoDownloaded(photo, saved.filePath, saved.thumbnailPath);
        downloaded++;
      } catch {
        // Missing, tampered with or not an image: nothing is kept; tried again next time,
        // a few times at most.
        await this.store.photoDownloadFailed(photo);
      }
    }
    return downloaded;
  }

  private async uploadOne(spaceId: string, photo: PhotoRef): Promise<void> {
    const bytes = await this.files.read(photo.filePath);
    if (!bytes || bytes.length === 0) throw new Error('Photo file missing');
    // An earlier attempt may have left parts under another header: start this photo again.
    if (photo.blobId) await this.transport.removeParts(spaceId, photo.blobId);
    const blobId = photo.blobId ?? newId();
    const encrypted = this.crypto.encryptBlob(bytes);
    // Recorded first, so a retry reuses the reservation instead of making another.
    await this.store.setPhotoBlob(photo, {
      blobId,
      key: toBase64(encrypted.fileKey),
      header: toBase64(encrypted.header),
      size: bytes.length,
    });
    await this.transport.reserve(blobId, bytes.length);
    for (let part = 0; part * CHUNKS_PER_PART < encrypted.chunks.length; part++) {
      const chunks = encrypted.chunks.slice(part * CHUNKS_PER_PART, (part + 1) * CHUNKS_PER_PART);
      await this.transport.upload(spaceId, blobId, part, concat(chunks));
    }
    await this.store.markPhotoUploaded(photo);
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** A stored part back into its encrypted chunks: all full-size except a photo's last. */
function splitPart(part: Uint8Array): Uint8Array[] {
  const size = CHUNK_PLAINTEXT_BYTES + CHUNK_OVERHEAD_BYTES;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < part.length; offset += size) {
    chunks.push(part.subarray(offset, Math.min(part.length, offset + size)));
  }
  return chunks;
}
