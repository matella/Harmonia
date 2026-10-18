import { Injectable, inject } from '@angular/core';

import type { Memory } from '../domain/models';
import { countBucket } from '../domain/usage-events';
import type { ValidMemory } from '../domain/validation';
import { MediaStorageService } from '../platform/media-storage.service';
import type { StoredMediaFile } from '../persistence/memory.repository';
import { DatabaseService } from './database.service';
import { SyncService } from './sync.service';
import { UsageService } from './usage.service';

@Injectable({ providedIn: 'root' })
export class MemoryService {
  private readonly db = inject(DatabaseService);
  private readonly media = inject(MediaStorageService);
  private readonly sync = inject(SyncService);
  private readonly usage = inject(UsageService);

  async create(input: ValidMemory, images: readonly Blob[]): Promise<Memory> {
    const files = await this.storeAll(images);
    try {
      const memory = await this.db.repos.memories.create(input, files);
      await this.sync.afterChange({ quiet: true });
      this.trackSaved(memory, true);
      return memory;
    } catch (error) {
      await this.media.remove(files.flatMap((f) => [f.filePath, f.thumbnailPath ?? '']));
      throw error;
    }
  }

  async update(id: string, input: ValidMemory, addImages: readonly Blob[], removeMediaIds: readonly string[]): Promise<Memory> {
    const files = await this.storeAll(addImages);
    const { memory, orphanedFiles } = await this.db.repos.memories.update(id, input, { add: files, removeIds: removeMediaIds });
    await this.media.remove(orphanedFiles);
    await this.sync.afterChange({ quiet: true });
    this.trackSaved(memory, false);
    return memory;
  }

  async delete(id: string): Promise<void> {
    const { orphanedFiles } = await this.db.repos.memories.delete(id);
    await this.media.remove(orphanedFiles);
    await this.sync.afterChange({ quiet: true });
    this.usage.track({ name: 'memory_deleted', props: {} });
  }

  private trackSaved(memory: Memory, isNew: boolean): void {
    this.usage.track({
      name: 'memory_saved',
      props: { is_new: isNew, photos: countBucket(memory.media.length), linked: memory.milestoneId !== null },
    });
  }

  private async storeAll(images: readonly Blob[]): Promise<StoredMediaFile[]> {
    const files: StoredMediaFile[] = [];
    for (const image of images) files.push(await this.media.store(image));
    return files;
  }
}
