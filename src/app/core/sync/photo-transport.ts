import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Encrypted photo parts on the server (docs/PARTNER_SYNC.md §18): reservations through
 * `reserve_blob`, the parts in the private `photos` bucket at `<space>/<blob>/<part>`.
 * Only ciphertext passes through here.
 */
export interface PhotoTransport {
  /** Reserves room for `size` plaintext bytes; throws `PhotoStorageFullError` at the limit. */
  reserve(blobId: string, size: number): Promise<void>;
  upload(spaceId: string, blobId: string, part: number, bytes: Uint8Array): Promise<void>;
  download(spaceId: string, blobId: string, part: number): Promise<Uint8Array>;
  /** Deletes every stored part of a photo (an interrupted upload starts again). */
  removeParts(spaceId: string, blobId: string): Promise<void>;
  /** Bytes reserved in my space, and the limit. */
  usage(): Promise<{ used: number; limit: number }>;
}

export class PhotoStorageFullError extends Error {
  readonly code = 'photoStorageFull';
  constructor() {
    super('The shared space has no room for more photos.');
    this.name = 'PhotoStorageFullError';
  }
}

/** A failed photo transfer; carries the operation only, never content. */
export class PhotoTransferError extends Error {
  constructor(readonly operation: string) {
    super(`Photo transfer failed: ${operation}`);
    this.name = 'PhotoTransferError';
  }
}

const BUCKET = 'photos';

export class SupabasePhotoTransport implements PhotoTransport {
  constructor(private readonly client: SupabaseClient) {}

  async reserve(blobId: string, size: number): Promise<void> {
    const { error } = await this.client.rpc('reserve_blob', { blob: blobId, size });
    if (!error) return;
    if (/storage full/.test(error.message ?? '')) throw new PhotoStorageFullError();
    throw new PhotoTransferError('reserve');
  }

  async upload(spaceId: string, blobId: string, part: number, bytes: Uint8Array): Promise<void> {
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(`${spaceId}/${blobId}/${part}`, bytes, {
        contentType: 'application/octet-stream',
        upsert: false,
      });
    if (error) throw new PhotoTransferError('upload');
  }

  async download(spaceId: string, blobId: string, part: number): Promise<Uint8Array> {
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .download(`${spaceId}/${blobId}/${part}`);
    if (error || !data) throw new PhotoTransferError('download');
    return new Uint8Array(await data.arrayBuffer());
  }

  async removeParts(spaceId: string, blobId: string): Promise<void> {
    const folder = `${spaceId}/${blobId}`;
    const { data, error } = await this.client.storage.from(BUCKET).list(folder);
    if (error) throw new PhotoTransferError('list');
    if (!data || data.length === 0) return;
    const removed = await this.client.storage
      .from(BUCKET)
      .remove(data.map((f) => `${folder}/${f.name}`));
    if (removed.error) throw new PhotoTransferError('remove');
  }

  async usage(): Promise<{ used: number; limit: number }> {
    const { data, error } = await this.client.rpc('space_storage');
    const row = (data as { used: number | string; limit_bytes: number | string }[] | null)?.[0];
    if (error || !row) throw new PhotoTransferError('usage');
    return { used: Number(row.used), limit: Number(row.limit_bytes) };
  }
}

/** Behaves like the server's rules, for tests: reservations, the limit, no overwrites. */
export class InMemoryPhotoTransport implements PhotoTransport {
  readonly parts = new Map<string, Uint8Array>();
  private readonly reserved = new Map<string, number>();
  limit = 2 * 1024 * 1024 * 1024;
  /** Fails the next upload of this part number, once (an interrupted transfer). */
  failNextUploadOfPart: number | null = null;

  async reserve(blobId: string, size: number): Promise<void> {
    const existing = this.reserved.get(blobId);
    if (existing !== undefined) {
      if (existing !== size) throw new PhotoTransferError('reserve');
      return;
    }
    const used = [...this.reserved.values()].reduce((n, s) => n + s, 0);
    if (used + size > this.limit) throw new PhotoStorageFullError();
    this.reserved.set(blobId, size);
  }

  async upload(spaceId: string, blobId: string, part: number, bytes: Uint8Array): Promise<void> {
    const size = this.reserved.get(blobId);
    if (size === undefined || part >= Math.ceil(size / (1024 * 1024))) {
      throw new PhotoTransferError('upload');
    }
    if (this.failNextUploadOfPart === part) {
      this.failNextUploadOfPart = null;
      throw new PhotoTransferError('upload');
    }
    const key = `${spaceId}/${blobId}/${part}`;
    if (this.parts.has(key)) throw new PhotoTransferError('upload');
    this.parts.set(key, bytes.slice());
  }

  async download(spaceId: string, blobId: string, part: number): Promise<Uint8Array> {
    const bytes = this.parts.get(`${spaceId}/${blobId}/${part}`);
    if (!bytes) throw new PhotoTransferError('download');
    return bytes.slice();
  }

  async removeParts(spaceId: string, blobId: string): Promise<void> {
    for (const key of [...this.parts.keys()]) {
      if (key.startsWith(`${spaceId}/${blobId}/`)) this.parts.delete(key);
    }
  }

  async usage(): Promise<{ used: number; limit: number }> {
    return {
      used: [...this.reserved.values()].reduce((n, s) => n + s, 0),
      limit: this.limit,
    };
  }
}
