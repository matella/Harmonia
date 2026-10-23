import { Injectable, inject } from '@angular/core';

import { AppStore } from '../state/app-store';
import { DatabaseService } from './database.service';
import { I18nService } from './i18n.service';
import { NoticeService } from './notice.service';
import { ReminderService } from './reminder.service';
import { WidgetService } from './widget.service';

export interface SyncOutcome {
  remindersOk: boolean;
  widgetsOk: boolean;
}

/**
 * Coordinates "persist first, then side effects". Reloads state from the database and
 * then reconciles reminders and the widget snapshot. Side-effect failures never undo
 * the saved data: they are reported with a pointer to the repair action.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly db = inject(DatabaseService);
  private readonly store = inject(AppStore);
  private readonly reminders = inject(ReminderService);
  private readonly widgets = inject(WidgetService);
  private readonly notice = inject(NoticeService);
  private readonly t = inject(I18nService).translator;
  private readonly changeListeners: (() => void)[] = [];

  /** Called after every local change (partner sharing uploads it). */
  onLocalChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  async reload(): Promise<void> {
    const { profile, milestones, memories, settings } = this.db.repos;
    const [p, m, r, mem, s] = await Promise.all([
      profile.get(),
      milestones.list(),
      milestones.listRules(),
      memories.list(),
      settings.load(),
    ]);
    this.store.profile.set(p);
    this.store.milestones.set(m);
    this.store.rules.set(r);
    this.store.memories.set(mem);
    this.store.settings.set(s);
  }

  /**
   * Reload, then run side effects. Call after every successful write. `remote` marks
   * changes that arrived from the partner, which must not be sent back.
   */
  async afterChange(options: { quiet?: boolean; remote?: boolean } = {}): Promise<SyncOutcome> {
    await this.reload();
    const outcome = await this.runSideEffects(options.quiet ?? false);
    if (!options.remote) for (const listener of this.changeListeners) listener();
    return outcome;
  }

  async runSideEffects(quiet: boolean): Promise<SyncOutcome> {
    const outcome: SyncOutcome = { remindersOk: true, widgetsOk: true };
    try {
      await this.reminders.reconcile();
    } catch {
      outcome.remindersOk = false;
    }
    try {
      await this.widgets.refresh();
    } catch {
      outcome.widgetsOk = false;
    }
    if (!quiet) {
      if (!outcome.remindersOk) await this.notice.show(this.t.t('sync.remindersFailed'), 'warning');
      else if (!outcome.widgetsOk) await this.notice.show(this.t.t('sync.widgetsFailed'), 'warning');
    }
    return outcome;
  }
}
