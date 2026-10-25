import { Injectable, inject } from '@angular/core';
import { strFromU8 } from 'fflate';

import { ArchiveError, readArchive } from '../domain/export-archive';
import { EXPORT_JSON_NAME, parseExportDocument } from '../domain/export-format';
import type { LanguagePreference } from '../domain/models';
import { planRestore } from '../domain/restore-plan';
import type { StoredMediaFile } from '../persistence/memory.repository';
import { RestoreNotEmptyError } from '../persistence/restore.repository';
import { MediaStorageService } from '../platform/media-storage.service';
import { AppStore } from '../state/app-store';
import { DatabaseService } from './database.service';
import { SharingService } from './sharing.service';
import { SyncService } from './sync.service';
import { CLOCK } from './tokens';

/** Why a restore didn't happen; nothing was saved in every case. */
export type RestoreFailure = 'notExport' | 'newerVersion' | 'damaged' | 'notEmpty' | 'failed';

export class RestoreError extends Error {
  constructor(readonly reason: RestoreFailure) {
    super(`Restore: ${reason}`);
  }
}

export interface RestoreReport {
  /** Photos that couldn't come back: left out of the export, or unreadable in it. */
  photosMissing: number;
  /** The restored language, so the app can reload into it. */
  language: LanguagePreference;
}

/** The JSON is small; a photo is a 2048 px JPEG of a few MB. Anything bigger isn't ours. */
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_PHOTO_BYTES = 32 * 1024 * 1024;

/**
 * Restores an export (`DataExportService`) into an empty app, from the welcome screen.
 * Never offered over existing data or while sharing (decided 2026-10-24): it doesn't
 * merge. The archive is read twice as a stream: the JSON first, then only the photos it
 * names. Photos are stored before the one database transaction and removed again if it
 * fails; reminders and widgets follow after the data is saved.
 */
@Injectable({ providedIn: 'root' })
export class DataRestoreService {
  private readonly db = inject(DatabaseService);
  private readonly store = inject(AppStore);
  private readonly media = inject(MediaStorageService);
  private readonly sync = inject(SyncService);
  private readonly sharing = inject(SharingService);
  private readonly clock = inject(CLOCK);

  async canRestore(): Promise<boolean> {
    if (this.store.hasProfile()) return false;
    if ((await this.sharing.ensureStatus()) !== 'off') return false;
    return this.db.repos.restore.isEmpty();
  }

  async restore(file: Blob): Promise<RestoreReport> {
    if (!(await this.canRestore())) throw new RestoreError('notEmpty');

    let text: string | null = null;
    await this.read(file, {
      wanted: (name) => name === EXPORT_JSON_NAME,
      onEntry: (_name, bytes) => {
        text = strFromU8(bytes);
      },
      maxEntryBytes: MAX_JSON_BYTES,
    });
    if (text === null) throw new RestoreError('notExport');
    const parsed = parseExportDocument(text);
    if (!parsed.ok) {
      throw new RestoreError(
        parsed.reason === 'unsupportedVersion'
          ? 'newerVersion'
          : parsed.reason === 'invalidContent'
            ? 'damaged'
            : 'notExport',
      );
    }
    const today = this.clock.now().toZonedDateTimeISO(this.clock.timeZoneId()).toPlainDate();
    const planned = planRestore(parsed.document, today);
    if (!planned.ok) throw new RestoreError('damaged');
    const { plan } = planned;

    const wanted = new Set(plan.photoPaths);
    const stored = new Map<string, StoredMediaFile>();
    try {
      await this.read(file, {
        wanted: (name) => wanted.has(name) && !stored.has(name),
        onEntry: async (name, bytes) => {
          try {
            stored.set(name, await this.media.storeDownloaded(bytes));
          } catch {
            // Not a readable photo: the record comes back without it.
          }
        },
        maxEntryBytes: MAX_PHOTO_BYTES,
      });
      await this.db.repos.restore.restore(plan, stored);
    } catch (error) {
      await this.media.remove(
        [...stored.values()].flatMap((f) => [
          f.filePath,
          ...(f.thumbnailPath ? [f.thumbnailPath] : []),
        ]),
      );
      if (error instanceof RestoreError) throw error;
      throw new RestoreError(error instanceof RestoreNotEmptyError ? 'notEmpty' : 'failed');
    }

    // Saved. Reminders and widgets follow; a failure there keeps the data (and says so).
    await this.sync.afterChange().catch(() => undefined);
    return {
      photosMissing: plan.photosNotInExport + (plan.photoPaths.length - stored.size),
      language: this.store.settings().language,
    };
  }

  private async read(file: Blob, options: Parameters<typeof readArchive>[1]): Promise<void> {
    try {
      await readArchive(file.stream(), options);
    } catch (error) {
      if (error instanceof ArchiveError)
        throw new RestoreError(error.reason === 'notZip' ? 'notExport' : 'damaged');
      throw error;
    }
  }
}
