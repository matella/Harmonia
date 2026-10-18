import { Injectable, inject } from '@angular/core';

import type { ValidProfile } from '../domain/validation';
import { MediaStorageService } from '../platform/media-storage.service';
import { AppStore } from '../state/app-store';
import { DatabaseService } from './database.service';
import { SyncService } from './sync.service';

export type PhotoChange = { kind: 'keep' } | { kind: 'set'; image: Blob } | { kind: 'remove' };

@Injectable({ providedIn: 'root' })
export class ProfileService {
  private readonly db = inject(DatabaseService);
  private readonly store = inject(AppStore);
  private readonly media = inject(MediaStorageService);
  private readonly sync = inject(SyncService);

  /**
   * Saves the profile. Changing the start date recalculates every duration (they are
   * derived) but never rewrites milestone dates.
   */
  async save(profile: ValidProfile, photo: PhotoChange = { kind: 'keep' }): Promise<void> {
    const previous = this.store.profile()?.photoPath ?? null;
    let photoPath: string | null | undefined;
    if (photo.kind === 'set') photoPath = (await this.media.store(photo.image)).filePath;
    else if (photo.kind === 'remove') photoPath = null;
    await this.db.repos.profile.save(profile, photoPath);
    if (photoPath !== undefined && previous && previous !== photoPath) {
      await this.media.remove(thumbnailSiblings(previous));
    }
    await this.sync.afterChange();
  }
}

/** A stored image path and its generated thumbnail. */
export function thumbnailSiblings(filePath: string): string[] {
  return [filePath, filePath.replace(/^media\//, 'media/thumbs/')];
}
