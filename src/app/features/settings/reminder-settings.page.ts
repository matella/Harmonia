import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { IonContent, IonIcon, IonSpinner, IonToggle } from '@ionic/angular';

import { MAX_PENDING_NOTIFICATIONS } from '../../core/domain/reminder-planner';
import { UsageService } from '../../core/services/usage.service';
import { I18nService } from '../../core/services/i18n.service';
import { NoticeService } from '../../core/services/notice.service';
import { ReminderService } from '../../core/services/reminder.service';
import { SettingsService } from '../../core/services/settings.service';
import { AppStore } from '../../core/state/app-store';
import { DateFieldComponent } from '../../shared/components/date-field.component';
import { ReminderOffsetsComponent } from '../../shared/components/reminder-offsets.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { SettingsHeaderComponent } from './settings-header.component';

@Component({
  selector: 'hm-reminder-settings',
  imports: [IonContent, IonToggle, IonIcon, IonSpinner, DateFieldComponent, ReminderOffsetsComponent, SettingsHeaderComponent, ...I18N_PIPES],
  template: `
    <hm-settings-header [title]="'reminders.title' | t" />
    <ion-content>
      <div class="hm-page">
        <section class="hm-section first" aria-labelledby="perm-heading">
          <h2 id="perm-heading" class="hm-section__title">{{ 'reminders.permission' | t }}</h2>
          <p class="hm-callout" [class.hm-callout--warning]="permission() === 'denied'">
            <ion-icon [name]="permission() === 'granted' ? 'notifications-outline' : 'notifications-off-outline'" aria-hidden="true" />
            <span>{{ permissionText() }}</span>
          </p>
          @if (permission() === 'granted' && reminders.lastReport(); as report) {
            <p class="hm-section__hint">{{ 'reminders.scheduled' | tp: report.scheduled }}</p>
          }
        </section>

        <section class="hm-section">
          <div class="hm-switch-row">
            <label class="hm-switch-row__text" for="r-enabled">
              {{ 'reminders.enabled' | t }}
              <span class="hm-switch-row__hint">{{ 'reminders.enabledHint' | t }}</span>
            </label>
            <ion-toggle id="r-enabled" [attr.aria-label]="'reminders.enabled' | t" [checked]="settings().remindersEnabled" (ionChange)="save({ remindersEnabled: $event.detail.checked })" />
          </div>
          <div class="hm-switch-row">
            <label class="hm-switch-row__text" for="r-reveal">
              {{ 'reminders.revealTitles' | t }}
              <span class="hm-switch-row__hint">{{ 'reminders.revealTitlesHint' | t }}</span>
            </label>
            <ion-toggle
              id="r-reveal" [attr.aria-label]="'reminders.revealTitles' | t"
              [checked]="settings().notificationsRevealTitles"
              (ionChange)="save({ notificationsRevealTitles: $event.detail.checked })"
            />
          </div>
          <div class="hm-switch-row">
            <label class="hm-switch-row__text" for="r-together">
              {{ 'reminders.together' | t }}
              <span class="hm-switch-row__hint">{{ 'reminders.togetherHint' | t }}</span>
            </label>
            <ion-toggle id="r-together" [attr.aria-label]="'reminders.together' | t" [checked]="settings().togetherReminders" (ionChange)="setTogether($event.detail.checked)" />
          </div>
          <div class="hm-switch-row">
            <label class="hm-switch-row__text" for="r-memories">
              {{ 'reminders.memories' | t }}
              <span class="hm-switch-row__hint">{{ 'reminders.memoriesHint' | t }}</span>
            </label>
            <ion-toggle id="r-memories" [attr.aria-label]="'reminders.memories' | t" [checked]="settings().memoryReminders" (ionChange)="setMemories($event.detail.checked)" />
          </div>
        </section>

        <section class="hm-section">
          <hm-date-field
            mode="time"
            [label]="'reminders.defaultTime' | t"
            [value]="settings().defaultReminderTime"
            (valueChange)="$event && save({ defaultReminderTime: $event })"
            [hint]="'reminders.defaultTimeHint' | t"
          />
        </section>

        <section class="hm-section" aria-labelledby="offsets-heading">
          <h2 id="offsets-heading" class="hm-field__label">{{ 'reminders.defaultOffsets' | t }}</h2>
          <p class="hm-section__hint offsets-hint">{{ 'reminders.defaultOffsetsHint' | t }}</p>
          <hm-reminder-offsets
            [label]="'reminders.defaultOffsets' | t"
            [selected]="settings().defaultReminderOffsets"
            (selectedChange)="save({ defaultReminderOffsets: $event })"
          />
        </section>

        <section class="hm-section" aria-labelledby="recheck-heading">
          <h2 id="recheck-heading" class="hm-section__title">{{ 'reminders.recheck' | t }}</h2>
          <p class="hm-section__hint">{{ 'reminders.recheckHint' | t }}</p>
          <button type="button" class="hm-btn hm-btn--outline recheck" [disabled]="checking()" (click)="recheck()">
            @if (checking()) {
              <ion-spinner name="crescent" />
            } @else {
              <ion-icon name="refresh-outline" aria-hidden="true" />
            }
            {{ 'reminders.recheck' | t }}
          </button>
          <p class="hm-section__hint" role="status">{{ result() }}</p>
          <p class="hm-section__hint">{{ 'reminders.limitNote' | t: { count: limit } }}</p>
        </section>
      </div>
    </ion-content>
  `,
  styles: `
    .first {
      margin-top: var(--hm-space-4);
    }
    .offsets-hint {
      margin-bottom: var(--hm-space-3);
    }
    .recheck {
      margin: var(--hm-space-4) 0 var(--hm-space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReminderSettingsPage implements OnInit {
  private readonly t = inject(I18nService).translator;
  private readonly store = inject(AppStore);
  private readonly service = inject(SettingsService);
  private readonly notice = inject(NoticeService);
  protected readonly reminders = inject(ReminderService);
  private readonly usage = inject(UsageService);

  protected readonly settings = this.store.settings;
  protected readonly permission = this.reminders.permission;
  protected readonly checking = signal(false);
  protected readonly result = signal('');
  protected readonly limit = MAX_PENDING_NOTIFICATIONS;

  protected readonly permissionText = computed(() => {
    switch (this.permission()) {
      case 'granted':
        return this.t.t('reminders.permission.granted');
      case 'denied':
        return this.t.t('reminders.permission.denied');
      case 'unavailable':
        return this.t.t('reminders.permission.unavailable');
      default:
        return this.t.t('reminders.permission.prompt');
    }
  });

  ngOnInit(): void {
    void this.reminders.refreshPermission().catch(() => undefined);
  }

  /** Asks for notification permission in context, the first time one is turned on. */
  protected async setMemories(enabled: boolean): Promise<void> {
    if (enabled) await this.reminders.requestIfNeeded().catch(() => undefined);
    await this.save({ memoryReminders: enabled });
  }

  protected async setTogether(enabled: boolean): Promise<void> {
    if (enabled) await this.reminders.requestIfNeeded().catch(() => undefined);
    await this.save({ togetherReminders: enabled });
  }

  protected async save(changes: Parameters<SettingsService['update']>[0]): Promise<void> {
    try {
      await this.service.update(changes);
    } catch {
      await this.notice.show(this.t.t('settings.saveFailed'), 'warning');
    }
  }

  /** Spec §7.5: compare saved rules with pending notifications, rebuild, report honestly. */
  protected async recheck(): Promise<void> {
    this.checking.set(true);
    try {
      const report = await this.reminders.reconcile();
      this.usage.track({ name: 'reminders_rechecked', props: { repaired: report.stale > 0 || report.missing > 0 } });
      if (report.permission === 'unavailable') this.result.set(this.t.t('reminders.recheckUnavailable'));
      else if (report.permission !== 'granted') this.result.set(this.t.t('reminders.recheckDenied'));
      else if (report.stale > 0 || report.missing > 0) {
        this.result.set(this.t.t('reminders.recheckRepaired', { scheduled: report.scheduled, removed: report.stale }));
      } else this.result.set(this.t.plural('reminders.recheckOk', report.scheduled));
    } catch {
      this.result.set(this.t.t('reminders.recheckFailed'));
    } finally {
      this.checking.set(false);
    }
  }
}
