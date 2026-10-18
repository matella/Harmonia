import { Injectable, inject } from '@angular/core';

import { MediaStorageService } from '../platform/media-storage.service';
import { DatabaseService } from './database.service';
import { ReminderService } from './reminder.service';
import { SyncService } from './sync.service';
import { UsageService } from './usage.service';
import { WidgetService } from './widget.service';

export interface DeletionReport {
  remindersCancelled: boolean;
  widgetsCleared: boolean;
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

  async deleteEverything(): Promise<DeletionReport> {
    const report: DeletionReport = { remindersCancelled: true, widgetsCleared: true };
    // Nothing queued may be sent afterwards; deleting settings also turns sharing off.
    this.usage.discard();
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
