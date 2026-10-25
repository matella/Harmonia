import { Injectable, computed, inject, signal } from '@angular/core';

import { planReminders, type PlannedNotification } from '../domain/reminder-planner';
import { reconcileReminders, type ReconcileReport } from '../domain/reminder-reconciler';
import { togetherOptionsFrom } from '../domain/together-milestones';
import { createReminderCopy } from '../i18n/reminder-copy';
import type { NotificationPermission } from '../platform/notification-port';
import { AppStore } from '../state/app-store';
import { I18nService } from './i18n.service';
import { UsageService } from './usage.service';
import { CLOCK, NOTIFICATION_PORT } from './tokens';

/**
 * Turns persisted reminder rules into OS notifications. Reconciliation is idempotent and
 * runs after every relevant change, on launch, on resume and on time-zone change. No
 * background polling is used.
 */
@Injectable({ providedIn: 'root' })
export class ReminderService {
  private readonly port = inject(NOTIFICATION_PORT);
  private readonly store = inject(AppStore);
  private readonly clock = inject(CLOCK);
  private readonly copy = createReminderCopy(inject(I18nService).translator);
  private readonly usage = inject(UsageService);

  readonly permission = signal<NotificationPermission>('prompt');
  readonly lastReport = signal<ReconcileReport | null>(null);
  readonly available = computed(() => this.permission() !== 'unavailable');
  readonly hasEnabledRules = computed(() => this.store.rules().some((r) => r.isEnabled));

  async refreshPermission(): Promise<NotificationPermission> {
    const permission = await this.port.checkPermission();
    this.permission.set(permission);
    return permission;
  }

  /**
   * Asks for notification permission only in context (the user just turned a reminder
   * on). Never re-prompts after a denial; the UI then points to system settings.
   */
  async requestIfNeeded(): Promise<NotificationPermission> {
    const current = await this.refreshPermission();
    if (current !== 'prompt') return current;
    const result = await this.port.requestPermission();
    this.permission.set(result);
    if (result === 'granted' || result === 'denied') this.usage.track({ name: 'notification_permission', props: { result } });
    return result;
  }

  plan(): PlannedNotification[] {
    const settings = this.store.settings();
    const profile = this.store.profile();
    return planReminders({
      milestones: this.store.milestones(),
      rules: this.store.rules(),
      settings,
      now: this.clock.now(),
      deviceTimeZoneId: this.clock.timeZoneId(),
      copy: this.copy,
      together:
        profile && settings.togetherReminders
          ? {
              startDate: profile.startDate,
              options: togetherOptionsFrom(settings, this.store.milestones(), profile.startDate),
              offsets: settings.defaultReminderOffsets,
              localTime: settings.defaultReminderTime,
              revealTitle: settings.notificationsRevealTitles,
            }
          : null,
      memoryReminders: settings.memoryReminders
        ? {
            memories: this.store.memories(),
            localTime: settings.defaultReminderTime,
            revealTitle: settings.notificationsRevealTitles,
          }
        : null,
    });
  }

  async reconcile(): Promise<ReconcileReport> {
    const report = await reconcileReminders(this.port, this.plan());
    this.permission.set(report.permission);
    this.lastReport.set(report);
    return report;
  }

  /** Cancels every pending reminder (used by delete-all). */
  async cancelAll(): Promise<void> {
    const pending = await this.port.pendingIds();
    if (pending.length > 0) await this.port.cancel(pending);
  }
}
