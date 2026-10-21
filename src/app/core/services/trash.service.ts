import { Injectable, inject, signal } from '@angular/core';

import type { TrashItem } from '../domain/models';
import { MediaStorageService } from '../platform/media-storage.service';
import { DatabaseService } from './database.service';
import { thumbnailSiblings } from './profile.service';
import { SyncService } from './sync.service';

/**
 * "Recently deleted": restore within 30 days, delete forever, and the startup purge.
 * Files are removed only after the database no longer references them.
 */
@Injectable({ providedIn: 'root' })
export class TrashService {
  private readonly db = inject(DatabaseService);
  private readonly media = inject(MediaStorageService);
  private readonly sync = inject(SyncService);

  readonly items = signal<TrashItem[]>([]);

  async refresh(): Promise<TrashItem[]> {
    const items = await this.db.repos.trash.list();
    this.items.set(items);
    return items;
  }

  async restore(item: TrashItem): Promise<void> {
    if (item.kind === 'milestone') await this.db.repos.trash.restoreMilestone(item.id);
    else await this.db.repos.trash.restoreMemory(item.id);
    await this.refresh();
    await this.sync.afterChange();
  }

  async deleteForever(item: TrashItem): Promise<void> {
    const files = await this.db.repos.trash.deleteForever(item.kind, item.id);
    await this.media.remove(withThumbnails(files));
    await this.refresh();
    await this.sync.afterChange({ quiet: true });
  }

  /** Called at startup, before orphan cleanup. Best-effort: retried on the next launch. */
  async purgeExpired(): Promise<void> {
    const files = await this.db.repos.trash.purgeExpired();
    if (files.length > 0) await this.media.remove(withThumbnails(files));
  }
}

/** Milestone cover photos are stored with a generated thumbnail next to them. */
function withThumbnails(files: readonly string[]): string[] {
  return [...new Set(files.flatMap((f) => (f.startsWith('media/thumbs/') ? [f] : thumbnailSiblings(f))))];
}
