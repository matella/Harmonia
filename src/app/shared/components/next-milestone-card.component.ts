import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonIcon } from '@ionic/angular';

import type { Occurrence } from '../../core/domain/milestone-occurrence';
import { CATEGORY_ICONS } from '../icons';
import { I18N_PIPES } from '../pipes/i18n.pipes';

/** Home's single card: the next date, its weekday and how far away it is. */
@Component({
  selector: 'hm-next-milestone-card',
  imports: [RouterLink, IonIcon, ...I18N_PIPES],
  template: `
    @let o = occurrence();
    <a class="card" [class.card--today]="o.status === 'today'" [routerLink]="['/milestone', o.milestone.id]">
      <span class="icon" aria-hidden="true"><ion-icon [name]="icon()" /></span>
      <span class="body">
        <span class="when">
          @if (o.status === 'today') {
            <span class="hm-badge hm-badge--today">{{ 'occurrence.status.today' | t }}</span>
          } @else {
            <span class="days hm-num">{{ o.daysFromToday | relativeDays }}</span>
          }
        </span>
        <span class="title">{{ o.milestone.title }}</span>
        <span class="date">{{ o.date | hmDate: 'full' }}</span>
        @if (o.milestone.recurrence === 'yearly' && o.occurrenceNumber > 0) {
          <span class="years">{{ 'occurrence.yearsSince' | tp: o.occurrenceNumber }}</span>
        }
      </span>
      <ion-icon class="chevron" name="chevron-forward" aria-hidden="true" />
    </a>
  `,
  styles: `
    :host {
      display: block;
    }
    .card {
      display: flex;
      align-items: center;
      gap: var(--hm-space-4);
      padding: var(--hm-space-5);
      border-radius: var(--hm-radius-card);
      background: var(--hm-surface);
      border: var(--hm-hairline);
      color: inherit;
      text-decoration: none;
    }
    .card--today {
      border-color: var(--hm-rose);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--hm-rose-soft) 45%, transparent);
    }
    .icon {
      align-self: flex-start;
      flex: none;
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--hm-surface-muted);
      color: var(--hm-berry);
      font-size: 21px;
    }
    .body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .title {
      font-family: var(--hm-font-display);
      font-size: var(--hm-text-lg);
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .date,
    .years {
      font-size: var(--hm-text-sm);
      color: var(--hm-ink-muted);
    }
    .when {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--hm-space-1) var(--hm-space-3);
      margin-bottom: 2px;
    }
    .days {
      font-family: var(--hm-font-display);
      font-size: var(--hm-text-xl);
      color: var(--hm-berry);
    }
    .chevron {
      flex: none;
      color: var(--hm-line-strong);
      font-size: 18px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NextMilestoneCardComponent {
  readonly occurrence = input.required<Occurrence>();
  protected readonly icon = computed(() => CATEGORY_ICONS[this.occurrence().milestone.category]);
}
