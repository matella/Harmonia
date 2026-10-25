import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ActionSheetController, IonContent, IonHeader, IonIcon, IonToolbar } from '@ionic/angular';

import { originalOccurrence, type Occurrence } from '../../core/domain/milestone-occurrence';
import { togetherMarkComesFirst } from '../../core/domain/together-milestones';
import { formatTogetherTitle } from '../../core/i18n/duration-format';
import type { CounterFormat } from '../../core/domain/models';
import { I18nService } from '../../core/services/i18n.service';
import { DataExportService } from '../../core/services/data-export.service';
import { NoticeService } from '../../core/services/notice.service';
import { NudgeService } from '../../core/services/nudge.service';
import { SettingsService } from '../../core/services/settings.service';
import { CLOCK } from '../../core/services/tokens';
import { SharingService } from '../../core/services/sharing.service';
import { AppStore } from '../../core/state/app-store';
import { CounterComponent } from '../../shared/components/counter.component';
import { EmblemComponent } from '../../shared/components/emblem.component';
import { EmptyStateComponent } from '../../shared/components/empty-state.component';
import { MilestoneRowComponent } from '../../shared/components/milestone-row.component';
import { NextMilestoneCardComponent, type NextMoment } from '../../shared/components/next-milestone-card.component';
import { CATEGORY_ICONS, TOGETHER_ICON } from '../../shared/icons';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { ReminderService } from '../../core/services/reminder.service';
import { UsageService } from '../../core/services/usage.service';
import { reminderStateFor } from '../../shared/utilities/reminder-state';

const FORMAT_CYCLE: CounterFormat[] = ['calendar', 'days', 'weeks'];
const STORY_LIMIT = 2;

@Component({
  selector: 'hm-home',
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonContent,
    IonIcon,
    CounterComponent,
    EmblemComponent,
    EmptyStateComponent,
    MilestoneRowComponent,
    NextMilestoneCardComponent,
    PhotoFrameComponent,
    ...I18N_PIPES,
  ],
  templateUrl: './home.page.html',
  styleUrl: './home.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomePage {
  protected readonly store = inject(AppStore);
  protected readonly t = inject(I18nService).translator;
  private readonly settings = inject(SettingsService);
  private readonly clock = inject(CLOCK);
  private readonly reminders = inject(ReminderService);
  private readonly router = inject(Router);
  private readonly sheets = inject(ActionSheetController);
  protected readonly usage = inject(UsageService);
  protected readonly nudges = inject(NudgeService);
  private readonly sharing = inject(SharingService);
  private readonly notice = inject(NoticeService);
  private readonly exporter = inject(DataExportService);
  protected readonly exporting = signal(false);

  protected readonly profile = this.store.profile;

  ionViewWillEnter(): void {
    void this.sharing.ensureStatus();
  }
  protected readonly format = computed(() => this.store.settings().counterFormat);
  /** The sooner of the next date and the next together milestone; a date wins a tie. */
  protected readonly next = computed<NextMoment | null>(() => {
    const occurrence = this.store.nextUpcoming();
    const mark = this.store.nextTogether();
    if (mark && togetherMarkComesFirst(mark, occurrence?.date ?? null)) {
      return {
        link: ['/counter'],
        icon: TOGETHER_ICON,
        title: formatTogetherTitle(this.t, mark),
        date: mark.date,
        status: mark.status,
        daysFromToday: mark.daysFromToday,
        detail: this.t.t('together.fromStart'),
      };
    }
    if (!occurrence) return null;
    const m = occurrence.milestone;
    return {
      link: ['/milestone', m.id],
      icon: CATEGORY_ICONS[m.category],
      title: m.title,
      date: occurrence.date,
      status: occurrence.status,
      daysFromToday: occurrence.daysFromToday,
      detail:
        m.recurrence === 'yearly' && occurrence.occurrenceNumber > 0
          ? this.t.plural('occurrence.yearsSince', occurrence.occurrenceNumber)
          : null,
    };
  });

  /** Pinned dates first, then the most recent past dates — at most two. */
  protected readonly story = computed<Occurrence[]>(() => {
    const today = this.store.today();
    const pinned = this.store
      .milestones()
      .filter((m) => m.isPinned)
      .map((m) => originalOccurrence(m, today))
      .sort((a, b) => a.date.toString().localeCompare(b.date.toString()));
    const recent = this.store.past().filter((o) => !o.milestone.isPinned);
    return [...pinned, ...recent].slice(0, STORY_LIMIT);
  });

  protected reminderState(milestoneId: string) {
    return reminderStateFor(milestoneId, this.store.rulesByMilestone(), this.store.settings(), this.reminders.permission());
  }

  protected async cycleFormat(): Promise<void> {
    const next = FORMAT_CYCLE[(FORMAT_CYCLE.indexOf(this.format()) + 1) % FORMAT_CYCLE.length];
    await this.settings.update({ counterFormat: next }).catch(() => undefined);
  }

  protected async openAddMenu(): Promise<void> {
    const sheet = await this.sheets.create({
      header: this.t.t('home.add'),
      buttons: [
        { text: this.t.t('home.addMilestone'), icon: 'calendar-outline', data: '/milestone/new' },
        { text: this.t.t('home.addMemory'), icon: 'image-outline', data: '/memory/new' },
        { text: this.t.t('common.cancel'), role: 'cancel' },
      ],
    });
    await sheet.present();
    const { data } = await sheet.onDidDismiss<string>();
    if (data) await this.router.navigateByUrl(data);
  }

  /** Either answer is final; the choice stays changeable in Privacy and data. */
  protected async answerUsage(share: boolean): Promise<void> {
    await this.settings.update({ usageSharing: share, usagePromptAnswered: true }).catch(() => undefined);
  }

  protected async sendNudge(): Promise<void> {
    const result = await this.nudges.send();
    await this.notice.show(
      this.t.t(result === 'sent' ? 'nudge.sent' : result === 'tooSoon' ? 'nudge.tooSoon' : 'nudge.failed'),
      result === 'sent' ? 'info' : 'warning',
    );
  }

  /** The offer to keep a copy: exports now, or waits 30 days. */
  protected async exportNow(): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    try {
      const result = await this.exporter.exportAndShare(this.t.t('privacy.exportShareTitle'));
      if (result.shared) await this.notice.show(this.t.t('backup.done'));
    } catch {
      await this.notice.show(this.t.t('privacy.exportFailed'), 'warning');
    } finally {
      this.exporting.set(false);
    }
  }

  protected async notNow(): Promise<void> {
    await this.settings.update({ backupPromptDismissedAt: this.clock.now().toString() }).catch(() => undefined);
  }

  protected addDate(): void {
    void this.router.navigateByUrl('/milestone/new');
  }
}
