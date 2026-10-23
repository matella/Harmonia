import { Injectable, inject } from '@angular/core';

import { MediaStorageService } from '../platform/media-storage.service';
import { DatabaseService } from './database.service';
import { ReminderService } from './reminder.service';
import { SharingService } from './sharing.service';
import { SyncService } from './sync.service';
import { UsageService } from './usage.service';
import { WidgetService } from './widget.service';

export interface DeletionReport {
  remindersCancelled: boolean;
  widgetsCleared: boolean;
  /** False when sharing was on and this device couldn't be taken out of the space. */
  sharingRemoved: boolean;
}

/**
 * Erases everything stored locally: pending reminders, database records, app-managed
 * photos, and the widget/watch snapshot (replaced by a neutral placeholder so no name or
 * date stays visible on a home screen or watch face).
 */
@Injectable({ providedIn: 'root' })
export class DataDeletionService {
  private readonly db = inject(DatabaseService);
  private readonly media = inject(MediaStorageService);
  private readonly reminders = inject(ReminderService);
  private readonly widgets = inject(WidgetService);
  private readonly sync = inject(SyncService);
  private readonly usage = inject(UsageService);
  private readonly sharing = inject(SharingService);

  async deleteEverything(): Promise<DeletionReport> {
    const report: DeletionReport = {
      remindersCancelled: true,
      widgetsCleared: true,
      sharingRemoved: true,
    };
    // Nothing queued may be sent afterwards; deleting settings also turns sharing off.
    this.usage.discard();
    // While sharing: this device leaves the space first (the others keep sharing), then
    // every sharing secret is forgotten. Offline, the wipe still goes ahead.
    report.sharingRemoved = await this.sharing.removeThisDevice();
    await this.sharing.forgetSecrets();
    try {
      await this.reminders.cancelAll();
    } catch {
      report.remindersCancelled = false;
    }
    await this.db.repos.data.deleteAll();
    await this.media.removeAll();
    try {
      await this.widgets.clear();
    } catch {
      report.widgetsCleared = false;
    }
    await this.sync.reload();
    return report;
  }
}
