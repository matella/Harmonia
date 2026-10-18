import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonIcon } from '@ionic/angular';

import type { Occurrence } from '../../core/domain/milestone-occurrence';
import { CATEGORY_ICONS } from '../icons';
import { I18N_PIPES } from '../pipes/i18n.pipes';

/**
 * A date in a list: icon, title, formatted date, recurrence and reminder state, and the
 * countdown or elapsed time. Status is conveyed with text, never color alone.
 */
@Component({
  selector: 'hm-milestone-row',
  imports: [RouterLink, IonIcon, ...I18N_PIPES],
  template: `
    @let o = occurrence();
    <a class="hm-row" [routerLink]="['/milestone', o.milestone.id]">
      <span class="hm-row__icon" aria-hidden="true"><ion-icon [name]="icon()" /></span>
      <span class="hm-row__body">
        <span class="hm-row__title">{{ o.milestone.title }}</span>
        <span class="hm-row__meta">
          <span>{{ o.date | hmDate: 'medium' }}</span>
          @if (o.milestone.recurrence === 'yearly') {
            <span><ion-icon name="repeat-outline" aria-hidden="true" />{{ 'occurrence.everyYear' | t }}</span>
          }
          @if (reminderState() === 'on') {
            <span><ion-icon name="notifications-outline" aria-hidden="true" />{{ 'occurrence.reminderOn' | t }}</span>
          } @else if (reminderState() === 'blocked') {
            <span><ion-icon name="notifications-off-outline" aria-hidden="true" />{{ 'occurrence.reminderBlocked' | t }}</span>
          }
          @if (o.milestone.isPinned) {
            <span><ion-icon name="bookmark" aria-hidden="true" />{{ 'occurrence.pinned' | t }}</span>
          }
        </span>
      </span>
      <span class="hm-row__trail">
        @if (o.status === 'today') {
          <span class="hm-badge hm-badge--today">{{ 'occurrence.status.today' | t }}</span>
        } @else if (o.status === 'upcoming') {
          <span class="countdown hm-num">{{ o.daysFromToday | relativeDays }}</span>
        } @else {
          <span class="hm-num">{{ o.daysFromToday | relativeDays }}</span>
        }
      </span>
    </a>
  `,
  styles: `
    :host {
      display: block;
    }
    .countdown {
      color: var(--hm-berry);
      font-weight: 500;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MilestoneRowComponent {
  readonly occurrence = input.required<Occurrence>();
  /** Whether the milestone has enabled reminders and whether they can be delivered. */
  readonly reminderState = input<'none' | 'on' | 'blocked'>('none');

  protected readonly icon = computed(() => CATEGORY_ICONS[this.occurrence().milestone.category]);
}
