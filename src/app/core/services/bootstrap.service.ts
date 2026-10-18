import { Injectable, inject } from '@angular/core';

import { MediaStorageService } from '../platform/media-storage.service';
import { DatabaseTooNewError, MigrationError } from '../persistence/migrations';
import { AppStore } from '../state/app-store';
import { DatabaseService } from './database.service';
import { LifecycleService } from './lifecycle.service';
import { thumbnailSiblings } from './profile.service';
import { SyncService } from './sync.service';
import { ThemeService } from './theme.service';

/**
 * Cold-start sequence: open + migrate the database, load state, then (off the critical
 * path) reconcile reminders, refresh the widget snapshot and clean orphaned media.
 * A database failure is surfaced on a recovery screen; nothing is wiped automatically.
 */
@Injectable({ providedIn: 'root' })
export class BootstrapService {
  private readonly db = inject(DatabaseService);
  private readonly store = inject(AppStore);
  private readonly sync = inject(SyncService);
  private readonly lifecycle = inject(LifecycleService);
  private readonly media = inject(MediaStorageService);

  constructor() {
    inject(ThemeService); // applies the theme as soon as settings load
  }

  async start(): Promise<void> {
    try {
      await this.db.open();
      await this.sync.reload();
    } catch (error) {
      this.store.failure.set(
        error instanceof MigrationError
          ? { kind: 'migration', detail: `${error.version}: ${error.causeMessage}` }
          : error instanceof DatabaseTooNewError
            ? { kind: 'too-new', detail: `${error.found} > ${error.supported}` }
            : { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) },
      );
      this.store.status.set('error');
      return;
    }
    this.store.status.set('ready');
    this.lifecycle.start();
    setTimeout(() => void this.afterStart(), 0);
  }

  private async afterStart(): Promise<void> {
    await this.sync.runSideEffects(true);
    try {
      const referenced = await this.db.repos.memories.referencedFiles();
      const withThumbs = new Set([...referenced].flatMap(thumbnailSiblings));
      await this.media.removeOrphans(withThumbs);
    } catch {
      // Cleanup is best-effort and retried on the next launch.
    }
  }
}
