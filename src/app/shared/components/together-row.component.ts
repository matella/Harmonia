import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonIcon } from '@ionic/angular';

import type { TogetherMark } from '../../core/domain/together-milestones';
import { formatTogetherTitle } from '../../core/i18n/duration-format';
import { I18nService } from '../../core/services/i18n.service';
import { TOGETHER_ICON } from '../icons';
import { I18N_PIPES } from '../pipes/i18n.pipes';

/**
 * A milestone together ("6 months together") in a list. Derived from the start date,
 * so it opens the counter rather than an editable date.
 */
@Component({
  selector: 'hm-together-row',
  imports: [RouterLink, IonIcon, ...I18N_PIPES],
  template: `
    @let m = mark();
    <a class="hm-row" routerLink="/counter">
      <span class="hm-row__icon" aria-hidden="true"><ion-icon [name]="icon" /></span>
      <span class="hm-row__body">
        <span class="hm-row__title">{{ title() }}</span>
        <span class="hm-row__meta">
          <span>{{ m.date | hmDate: 'medium' }}</span>
          @if (showOrigin()) {
            <span>{{ 'together.fromStart' | t }}</span>
          }
        </span>
      </span>
      <span class="hm-row__trail">
        @if (m.status === 'today') {
          <span class="hm-badge hm-badge--today">{{ 'occurrence.status.today' | t }}</span>
        } @else {
          <span class="countdown hm-num">{{ m.daysFromToday | relativeDays }}</span>
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
export class TogetherRowComponent {
  private readonly t = inject(I18nService).translator;
  readonly mark = input.required<TogetherMark>();
  /** Off where the surrounding section already says the dates come from the start date. */
  readonly showOrigin = input(true);
  protected readonly icon = TOGETHER_ICON;
  protected readonly title = computed(() => formatTogetherTitle(this.t, this.mark()));
}
