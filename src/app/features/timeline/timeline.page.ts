import { ChangeDetectionStrategy, Component, computed, inject, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular';

import { compareMilestonesSameDay, type OccurrenceStatus } from '../../core/domain/milestone-occurrence';
import { daysBetween, toPlainDate } from '../../core/domain/local-date';
import type { Memory, Milestone } from '../../core/domain/models';
import { Temporal } from '../../core/domain/temporal';
import { I18nService } from '../../core/services/i18n.service';
import { SettingsService } from '../../core/services/settings.service';
import { AppStore } from '../../core/state/app-store';
import { EmptyStateComponent } from '../../shared/components/empty-state.component';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { CATEGORY_ICONS } from '../../shared/icons';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';

type Entry =
  | { kind: 'start'; key: string; date: Temporal.PlainDate }
  | { kind: 'today'; key: string; date: Temporal.PlainDate }
  | { kind: 'milestone'; key: string; date: Temporal.PlainDate; status: OccurrenceStatus; milestone: Milestone }
  | { kind: 'memory'; key: string; date: Temporal.PlainDate; status: OccurrenceStatus; memory: Memory };

const KIND_ORDER: Record<Entry['kind'], number> = { start: 0, milestone: 1, memory: 2, today: 3 };

/**
 * The narrative timeline: the beginning, every date and memory in order, and a "today"
 * marker separating what happened from what is coming. Past/today/future are labelled in
 * text, not only by color.
 */
@Component({
  selector: 'hm-timeline',
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonIcon,
    IonContent,
    EmptyStateComponent,
    PhotoFrameComponent,
    ...I18N_PIPES,
  ],
  templateUrl: './timeline.page.html',
  styleUrl: './timeline.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelinePage {
  protected readonly store = inject(AppStore);
  protected readonly t = inject(I18nService).translator;
  private readonly settings = inject(SettingsService);
  private readonly router = inject(Router);
  private readonly content = viewChild(IonContent);

  protected readonly icons = CATEGORY_ICONS;
  protected readonly order = computed(() => this.store.settings().timelineOrder);
  protected readonly isEmpty = computed(() => this.store.milestones().length === 0 && this.store.memories().length === 0);

  protected readonly entries = computed<Entry[]>(() => {
    const today = this.store.today();
    const status = (date: Temporal.PlainDate): OccurrenceStatus => {
      const d = daysBetween(today, date);
      return d === 0 ? 'today' : d > 0 ? 'upcoming' : 'past';
    };
    const list: Entry[] = [];
    const profile = this.store.profile();
    if (profile) list.push({ kind: 'start', key: 'start', date: toPlainDate(profile.startDate) });
    list.push({ kind: 'today', key: 'today', date: today });
    for (const milestone of this.store.milestones()) {
      const date = toPlainDate(milestone.eventDate);
      list.push({ kind: 'milestone', key: `m-${milestone.id}`, date, status: status(date), milestone });
    }
    for (const memory of this.store.memories()) {
      const date = toPlainDate(memory.memoryDate);
      list.push({ kind: 'memory', key: `r-${memory.id}`, date, status: status(date), memory });
    }
    list.sort((a, b) => {
      const byDate = Temporal.PlainDate.compare(a.date, b.date);
      if (byDate !== 0) return byDate;
      if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (a.kind === 'milestone' && b.kind === 'milestone') return compareMilestonesSameDay(a.milestone, b.milestone);
      if (a.kind === 'memory' && b.kind === 'memory') return a.memory.createdAt.localeCompare(b.memory.createdAt);
      return 0;
    });
    return this.order() === 'newest' ? list.reverse() : list;
  });

  protected async toggleOrder(): Promise<void> {
    await this.settings.update({ timelineOrder: this.order() === 'oldest' ? 'newest' : 'oldest' }).catch(() => undefined);
    await this.content()?.scrollToTop(0);
  }

  /** "Latest" = the today marker, where past meets future. */
  protected async jumpToLatest(): Promise<void> {
    const element = document.getElementById('timeline-today');
    const content = this.content();
    if (!element || !content) return;
    const scroll = await content.getScrollElement();
    const offset = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 120;
    await content.scrollToPoint(0, Math.max(0, offset), 300);
    element.focus({ preventScroll: true });
  }

  protected add(): void {
    void this.router.navigateByUrl('/milestone/new');
  }
}
