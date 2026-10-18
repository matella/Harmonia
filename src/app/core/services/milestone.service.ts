import { Injectable, inject } from '@angular/core';

import type { Milestone } from '../domain/models';
import type { ValidMilestone } from '../domain/validation';
import { MediaStorageService } from '../platform/media-storage.service';
import { AppStore } from '../state/app-store';
import { DatabaseService } from './database.service';
import { thumbnailSiblings, type PhotoChange } from './profile.service';
import { ReminderService } from './reminder.service';
import { SyncService } from './sync.service';

export interface MilestoneSaveResult {
  milestone: Milestone;
  /** Notification permission after saving, when the milestone has reminders. */
  permission: Awaited<ReturnType<ReminderService['refreshPermission']>> | null;
}

@Injectable({ providedIn: 'root' })
export class MilestoneService {
  private readonly db = inject(DatabaseService);
  private readonly store = inject(AppStore);
  private readonly media = inject(MediaStorageService);
  private readonly reminders = inject(ReminderService);
  private readonly sync = inject(SyncService);

  async create(input: ValidMilestone, photo: PhotoChange = { kind: 'keep' }): Promise<MilestoneSaveResult> {
    const photoPath = photo.kind === 'set' ? (await this.media.store(photo.image)).filePath : null;
    const milestone = await this.db.repos.milestones.create(input, photoPath);
    return this.finish(milestone, input);
  }

  async update(id: string, input: ValidMilestone, photo: PhotoChange = { kind: 'keep' }): Promise<MilestoneSaveResult> {
    const previous = this.store.milestoneById(id)?.photoPath ?? null;
    let photoPath: string | null | undefined;
    if (photo.kind === 'set') photoPath = (await this.media.store(photo.image)).filePath;
    else if (photo.kind === 'remove') photoPath = null;
    const milestone = await this.db.repos.milestones.update(id, input, photoPath);
    if (photoPath !== undefined && previous && previous !== photoPath) {
      await this.media.remove(thumbnailSiblings(previous));
    }
    return this.finish(milestone, input);
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.db.repos.milestones.setPinned(id, pinned);
    await this.sync.afterChange();
  }

  async delete(id: string, deleteLinkedMemories: boolean): Promise<void> {
    const { orphanedFiles } = await this.db.repos.milestones.delete(id, { deleteLinkedMemories });
    await this.media.remove(orphanedFiles.flatMap(thumbnailSiblings));
    await this.sync.afterChange();
  }

  private async finish(milestone: Milestone, input: ValidMilestone): Promise<MilestoneSaveResult> {
    // Persisted first; permission is requested only now, in context, if reminders are on.
    const permission = input.reminders.length > 0 ? await this.reminders.requestIfNeeded().catch(() => null) : null;
    await this.sync.afterChange();
    return { milestone, permission };
  }
}
