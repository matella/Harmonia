import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonToolbar } from '@ionic/angular';

import { nextOccurrence, originalOccurrence } from '../../core/domain/milestone-occurrence';
import { I18nService } from '../../core/services/i18n.service';
import { MilestoneService } from '../../core/services/milestone.service';
import { NoticeService } from '../../core/services/notice.service';
import { ReminderService } from '../../core/services/reminder.service';
import { AppStore } from '../../core/state/app-store';
import { EmptyStateComponent } from '../../shared/components/empty-state.component';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { CATEGORY_ICONS } from '../../shared/icons';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { ConfirmService } from '../../shared/services/confirm.service';
import { reminderStateFor } from '../../shared/utilities/reminder-state';

@Component({
  selector: 'hm-milestone-detail',
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonButton,
    IonContent,
    IonIcon,
    EmptyStateComponent,
    PhotoFrameComponent,
    ...I18N_PIPES,
  ],
  templateUrl: './milestone-detail.page.html',
  styleUrl: './milestone-detail.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MilestoneDetailPage {
  protected readonly store = inject(AppStore);
  protected readonly t = inject(I18nService).translator;
  private readonly service = inject(MilestoneService);
  private readonly reminders = inject(ReminderService);
  private readonly confirm = inject(ConfirmService);
  private readonly notice = inject(NoticeService);
  private readonly router = inject(Router);

  readonly id = input.required<string>();

  protected readonly milestone = computed(() => this.store.milestoneById(this.id()));
  protected readonly icon = computed(() => {
    const m = this.milestone();
    return m ? CATEGORY_ICONS[m.category] : 'star-outline';
  });
  protected readonly next = computed(() => {
    const m = this.milestone();
    return m ? nextOccurrence(m, this.store.today(), this.store.settings().leapDayPolicy) : null;
  });
  protected readonly original = computed(() => {
    const m = this.milestone();
    return m ? originalOccurrence(m, this.store.today()) : null;
  });
  protected readonly rules = computed(() => this.store.rulesByMilestone().get(this.id()) ?? []);
  protected readonly memories = computed(() => this.store.memoriesByMilestone().get(this.id()) ?? []);
  protected readonly permission = this.reminders.permission;
  protected readonly reminderState = computed(() =>
    reminderStateFor(this.id(), this.store.rulesByMilestone(), this.store.settings(), this.reminders.permission()),
  );

  protected async togglePin(): Promise<void> {
    const m = this.milestone();
    if (!m) return;
    try {
      await this.service.setPinned(m.id, !m.isPinned);
    } catch {
      await this.notice.show(this.t.t('milestone.saveFailed'), 'warning');
    }
  }

  protected async delete(): Promise<void> {
    const m = this.milestone();
    if (!m) return;
    const linked = this.memories().length;
    let deleteMemories = false;
    if (linked > 0) {
      const choice = await this.confirm.choose(
        this.t.t('milestone.deleteTitle'),
        this.t.plural('milestone.deleteWithMemoriesBody', linked),
        [
          { value: 'keep', label: this.t.t('milestone.deleteKeepMemories'), destructive: true },
          { value: 'all', label: this.t.t('milestone.deleteAll'), destructive: true },
        ],
      );
      if (!choice) return;
      deleteMemories = choice === 'all';
    } else if (
      !(await this.confirm.confirmDestructive(this.t.t('milestone.deleteTitle'), this.t.t('milestone.deleteBody'), this.t.t('common.delete')))
    ) {
      return;
    }
    try {
      await this.service.delete(m.id, deleteMemories);
      await this.router.navigateByUrl('/tabs/dates', { replaceUrl: true });
      await this.notice.show(this.t.t('milestone.deleted'));
    } catch {
      await this.notice.show(this.t.t('milestone.saveFailed'), 'warning');
    }
  }
}
