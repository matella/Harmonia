import { Injectable } from '@angular/core';
import { Camera, MediaTypeSelection } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

import { newId } from '../persistence/ids';
import type { StoredMediaFile } from '../persistence/memory.repository';

/** All app-managed media lives under this folder of the private data directory. */
export const MEDIA_ROOT = 'media';
const THUMB_DIR = `${MEDIA_ROOT}/thumbs`;
const MANAGED_PATH = /^media\/(thumbs\/)?[0-9a-f-]{36}\.jpg$/;

const FULL_MAX_EDGE = 2048;
const THUMB_MAX_EDGE = 480;
export const MAX_PHOTOS_PER_PICK = 10;

export function isManagedMediaPath(path: string): boolean {
  return MANAGED_PATH.test(path);
}

/**
 * Picks, normalizes and stores photos in app-private storage.
 *
 * Photos are re-encoded as JPEG with their EXIF orientation applied (so they display
 * upright everywhere) and without metadata — which also strips location data. A
 * 480 px thumbnail is generated for lists. Uses the system photo picker; no broad
 * photo-library permission is requested.
 */
@Injectable({ providedIn: 'root' })
export class MediaStorageService {
  private readonly urlCache = new Map<string, string>();

  /** Lets the user choose photos. Resolves to an empty list if they cancel. */
  async pickImages(multiple: boolean): Promise<Blob[]> {
    if (!Capacitor.isNativePlatform()) return pickWithFileInput(multiple);
    try {
      const { results } = await Camera.chooseFromGallery({
        mediaType: MediaTypeSelection.Photo,
        allowMultipleSelection: multiple,
        limit: multiple ? MAX_PHOTOS_PER_PICK : 1,
        quality: 90,
      });
      const blobs: Blob[] = [];
      for (const result of results) {
        if (!result.webPath) continue;
        blobs.push(await (await fetch(result.webPath)).blob());
      }
      return blobs;
    } catch (error) {
      if (isCancellation(error)) return [];
      throw error;
    }
  }

  async store(image: Blob): Promise<StoredMediaFile> {
    const bitmap = await createImageBitmap(image, { imageOrientation: 'from-image' });
    try {
      const id = newId();
      const filePath = `${MEDIA_ROOT}/${id}.jpg`;
      const thumbnailPath = `${THUMB_DIR}/${id}.jpg`;
      const full = await encodeJpeg(bitmap, FULL_MAX_EDGE, 0.88);
      const thumb = await encodeJpeg(bitmap, THUMB_MAX_EDGE, 0.8);
      await Filesystem.writeFile({ path: filePath, data: full, directory: Directory.Data, recursive: true });
      await Filesystem.writeFile({ path: thumbnailPath, data: thumb, directory: Directory.Data, recursive: true });
      return { filePath, thumbnailPath };
    } finally {
      bitmap.close();
    }
  }

  /** A URL usable in <img src>. */
  async displayUrl(path: string): Promise<string | null> {
    if (!isManagedMediaPath(path)) return null;
    const cached = this.urlCache.get(path);
    if (cached) return cached;
    try {
      let url: string;
      if (Capacitor.isNativePlatform()) {
        const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
        url = Capacitor.convertFileSrc(uri);
      } else {
        url = `data:image/jpeg;base64,${await this.readBase64(path)}`;
      }
      this.urlCache.set(path, url);
      return url;
    } catch {
      return null;
    }
  }

  async readBase64(path: string): Promise<string | null> {
    if (!isManagedMediaPath(path)) return null;
    try {
      const { data } = await Filesystem.readFile({ path, directory: Directory.Data });
      return typeof data === 'string' ? data : await blobToBase64(data);
    } catch {
      return null;
    }
  }

  /** Deletes app-managed files only; anything outside media/ is ignored. */
  async remove(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      if (!isManagedMediaPath(path)) continue;
      this.urlCache.delete(path);
      try {
        await Filesystem.deleteFile({ path, directory: Directory.Data });
      } catch {
        // Already gone.
      }
    }
  }

  /** Removes managed files that no database row references. Returns the count. */
  async removeOrphans(referenced: ReadonlySet<string>): Promise<number> {
    const all = await this.listManaged();
    const orphans = all.filter((path) => !referenced.has(path));
    await this.remove(orphans);
    return orphans.length;
  }

  async removeAll(): Promise<void> {
    this.urlCache.clear();
    try {
      await Filesystem.rmdir({ path: MEDIA_ROOT, directory: Directory.Data, recursive: true });
    } catch {
      // Nothing stored yet.
    }
  }

  private async listManaged(): Promise<string[]> {
    const paths: string[] = [];
    for (const dir of [MEDIA_ROOT, THUMB_DIR]) {
      try {
        const { files } = await Filesystem.readdir({ path: dir, directory: Directory.Data });
        for (const file of files) {
          const path = `${dir}/${file.name}`;
          if (isManagedMediaPath(path)) paths.push(path);
        }
      } catch {
        // Directory does not exist yet.
      }
    }
    return paths;
  }
}

async function encodeJpeg(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<string> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), 'image/jpeg', quality),
  );
  return blobToBase64(blob);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function isCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cancel/i.test(message);
}

function pickWithFileInput(multiple: boolean): Promise<Blob[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    input.addEventListener('change', () => resolve(Array.from(input.files ?? []).slice(0, MAX_PHOTOS_PER_PICK)));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
