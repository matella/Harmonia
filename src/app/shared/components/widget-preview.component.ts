import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { calendarDurationBetween } from '../../core/domain/relationship-duration';
import { daysBetween, toPlainDate } from '../../core/domain/local-date';
import type { WidgetSnapshot } from '../../core/domain/widget-snapshot';
import type { Temporal } from '../../core/domain/temporal';
import { formatShortCalendarDuration } from '../../core/i18n/duration-format';
import { I18nService } from '../../core/services/i18n.service';
import { EmblemComponent } from './emblem.component';

/**
 * In-app preview of what the native widgets render from the current snapshot, so the
 * privacy and counter choices can be judged before leaving the app. It mirrors the
 * native layouts; it is not itself a widget.
 */
@Component({
  selector: 'hm-widget-preview',
  imports: [EmblemComponent],
  template: `
    @let s = snapshot();
    <div class="previews" aria-hidden="true">
      <div class="widget widget--small">
        @if (s.state === 'ready') {
          @if (s.privacy !== 'minimal') {
            <hm-emblem [size]="22" />
          }
          <span class="big hm-num">{{ primary() }}</span>
          <span class="small">{{ secondary() }}</span>
        } @else {
          <hm-emblem [size]="28" />
          <span class="small">{{ t.t('widgets.placeholderTitle') }}</span>
        }
      </div>
      <div class="widget widget--medium">
        @if (s.state === 'ready') {
          <div class="col">
            @if (s.privacy !== 'minimal') {
              <span class="brand">{{ s.displayName ?? t.t('app.name') }}</span>
            }
            <span class="big hm-num">{{ primary() }}</span>
            <span class="small">{{ secondary() }}</span>
          </div>
          @if (next(); as n) {
            <div class="col col--next">
              <span class="small">{{ n.title }}</span>
              <span class="mid">{{ t.formatDate(n.date, 'monthDay') }}</span>
              <span class="small">{{ t.plural('widgets.nextIn', n.days) }}</span>
            </div>
          } @else if (s.privacy !== 'minimal') {
            <div class="col col--next"><hm-emblem [size]="34" /></div>
          }
        } @else {
          <div class="col"><hm-emblem [size]="28" /><span class="small">{{ t.t('widgets.placeholderTitle') }}</span></div>
        }
      </div>
    </div>
  `,
  styles: `
    .previews {
      display: flex;
      gap: var(--hm-space-4);
      align-items: stretch;
    }
    .widget {
      border-radius: 24px;
      background: var(--hm-surface);
      border: var(--hm-hairline);
      box-shadow: var(--hm-shadow);
      padding: var(--hm-space-4);
      display: flex;
      color: var(--hm-ink);
    }
    .widget--small {
      flex: none;
      width: 132px;
      aspect-ratio: 1;
      flex-direction: column;
      justify-content: space-between;
    }
    .widget--medium {
      flex: 1;
      min-width: 0;
      gap: var(--hm-space-4);
    }
    .col {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 2px;
    }
    .col--next {
      border-inline-start: var(--hm-hairline);
      padding-inline-start: var(--hm-space-3);
      align-items: flex-start;
    }
    .brand {
      font-family: var(--hm-font-display);
      font-size: var(--hm-text-sm);
      color: var(--hm-ink-muted);
    }
    .big {
      font-family: var(--hm-font-display);
      font-size: 1.9rem;
      line-height: 1.05;
      color: var(--hm-berry);
    }
    .mid {
      font-family: var(--hm-font-display);
      font-size: var(--hm-text-lg);
    }
    .small {
      font-size: var(--hm-text-xs);
      color: var(--hm-ink-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    @media (max-width: 380px) {
      .previews {
        flex-direction: column;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WidgetPreviewComponent {
  protected readonly t = inject(I18nService).translator;

  readonly snapshot = input.required<WidgetSnapshot>();
  readonly today = input.required<Temporal.PlainDate>();

  private readonly totalDays = computed(() => {
    const s = this.snapshot();
    return s.startDate ? Math.max(0, daysBetween(toPlainDate(s.startDate), this.today())) : 0;
  });

  protected readonly primary = computed(() => {
    const s = this.snapshot();
    if (s.counterMode === 'calendar' && s.startDate) {
      return formatShortCalendarDuration(this.t, calendarDurationBetween(toPlainDate(s.startDate), this.today()));
    }
    return this.t.formatNumber(this.totalDays());
  });

  protected readonly secondary = computed(() => {
    const s = this.snapshot();
    return s.counterMode === 'calendar'
      ? this.t.plural('counter.daysTogether', this.totalDays())
      : this.t.plural('widgets.daysLabel', this.totalDays());
  });

  protected readonly next = computed(() => {
    const upcoming = this.snapshot().upcoming.find((u) => u.date >= this.today().toString());
    if (!upcoming) return null;
    const date = toPlainDate(upcoming.date);
    return { title: upcoming.title ?? '', date, days: daysBetween(this.today(), date) };
  });
}
