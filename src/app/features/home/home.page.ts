import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ActionSheetController, IonContent, IonHeader, IonIcon, IonToolbar } from '@ionic/angular';

import { originalOccurrence, type Occurrence } from '../../core/domain/milestone-occurrence';
import type { CounterFormat } from '../../core/domain/models';
import { I18nService } from '../../core/services/i18n.service';
import { SettingsService } from '../../core/services/settings.service';
import { AppStore } from '../../core/state/app-store';
import { CounterComponent } from '../../shared/components/counter.component';
import { EmblemComponent } from '../../shared/components/emblem.component';
import { EmptyStateComponent } from '../../shared/components/empty-state.component';
import { MilestoneRowComponent } from '../../shared/components/milestone-row.component';
import { NextMilestoneCardComponent } from '../../shared/components/next-milestone-card.component';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { ReminderService } from '../../core/services/reminder.service';
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
  private readonly reminders = inject(ReminderService);
  private readonly router = inject(Router);
  private readonly sheets = inject(ActionSheetController);

  protected readonly profile = this.store.profile;
  protected readonly format = computed(() => this.store.settings().counterFormat);
  protected readonly next = this.store.nextUpcoming;

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

  protected addDate(): void {
    void this.router.navigateByUrl('/milestone/new');
  }
}
