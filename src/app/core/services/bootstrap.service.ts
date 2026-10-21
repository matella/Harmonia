import { Injectable, inject, isDevMode } from '@angular/core';

import { MediaStorageService } from '../platform/media-storage.service';
import { DatabaseTooNewError, MigrationError } from '../persistence/migrations';
import { AppStore } from '../state/app-store';
import { DatabaseService } from './database.service';
import { I18nService } from './i18n.service';
import { LifecycleService } from './lifecycle.service';
import { thumbnailSiblings } from './profile.service';
import { SyncService } from './sync.service';
import { ThemeService } from './theme.service';
import { TrashService } from './trash.service';
import { UsageService } from './usage.service';

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
  private readonly i18n = inject(I18nService);
  private readonly usage = inject(UsageService);
  private readonly trash = inject(TrashService);

  constructor() {
    inject(ThemeService); // applies the theme as soon as settings load
  }

  async start(): Promise<void> {
    try {
      await this.db.open();
      await this.sync.reload();
      // Before the UI renders; changing the language later reloads the app.
      this.i18n.apply(this.store.settings().language);
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
    // Phase 0 sharing spike: DevTools hooks in development builds only (docs/PARTNER_SYNC.md §15).
    if (isDevMode()) void import('../sync/dev-hooks').then((m) => m.installSyncDevHooks());
    setTimeout(() => void this.afterStart(), 0);
  }

  private async afterStart(): Promise<void> {
    await this.sync.runSideEffects(true);
    this.usage.trackStart();
    try {
      // Purge first: items older than 30 days leave the trash, then their files are orphans.
      await this.trash.purgeExpired();
      const referenced = await this.db.repos.memories.referencedFiles();
      const withThumbs = new Set([...referenced].flatMap(thumbnailSiblings));
      await this.media.removeOrphans(withThumbs);
    } catch {
      // Cleanup is best-effort and retried on the next launch.
    }
  }
}
