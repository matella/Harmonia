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
  /** Frees a photo's reservation; refused by the server while parts remain. */
  release(blobId: string): Promise<void>;
  /** Deletes every photo of the space (before leaving it); true once none is left. */
  removeSpace(spaceId: string): Promise<boolean>;
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
const LIST_PAGE = 100;

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
    // Listing is paginated: take every page before removing anything.
    const names = (await this.listAll(folder)).map((name) => `${folder}/${name}`);
    for (let i = 0; i < names.length; i += LIST_PAGE) {
      const removed = await this.client.storage.from(BUCKET).remove(names.slice(i, i + LIST_PAGE));
      if (removed.error) throw new PhotoTransferError('remove');
    }
  }

  async release(blobId: string): Promise<void> {
    const { error } = await this.client.rpc('release_blob', { blob: blobId });
    if (error) throw new PhotoTransferError('release');
  }

  async removeSpace(spaceId: string): Promise<boolean> {
    // One folder per photo, one level at a time.
    for (const blob of await this.listAll(spaceId)) await this.removeParts(spaceId, blob);
    return (await this.listAll(spaceId)).length === 0;
  }

  /** Every name in a folder (files, or subfolders), across all pages. */
  private async listAll(folder: string): Promise<string[]> {
    const names: string[] = [];
    for (let offset = 0; ; offset += LIST_PAGE) {
      const { data, error } = await this.client.storage
        .from(BUCKET)
        .list(folder, { limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error || !data) throw new PhotoTransferError('list');
      names.push(...data.map((f) => f.name));
      if (data.length < LIST_PAGE) return names;
    }
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

  async release(blobId: string): Promise<void> {
    if ([...this.parts.keys()].some((k) => k.split('/')[1] === blobId)) {
      throw new PhotoTransferError('release'); // parts remain
    }
    this.reserved.delete(blobId);
  }

  async removeSpace(spaceId: string): Promise<boolean> {
    for (const key of [...this.parts.keys()]) {
      if (key.startsWith(`${spaceId}/`)) this.parts.delete(key);
    }
    return true;
  }

  async usage(): Promise<{ used: number; limit: number }> {
    return {
      used: [...this.reserved.values()].reduce((n, s) => n + s, 0),
      limit: this.limit,
    };
  }
}
