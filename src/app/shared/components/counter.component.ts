import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import type { CounterFormat } from '../../core/domain/models';
import type { RelationshipCounter } from '../../core/domain/relationship-duration';
import {
  calendarParts,
  formatCalendarDuration,
  formatShortCalendarDuration,
  formatWeeksAndDays,
} from '../../core/i18n/duration-format';
import { I18nService } from '../../core/services/i18n.service';

interface Part {
  value: string;
  unit: string;
}

/**
 * The relationship counter: large, stable serif numerals with small unit words.
 * Values are derived from the persisted start date on every render; nothing ticks.
 * When interactive, tapping cycles between the calendar, total-days and weeks views.
 */
@Component({
  selector: 'hm-counter',
  template: `
    @let c = counter();
    @if (c) {
      <button
        type="button"
        class="counter"
        [class.counter--static]="!interactive()"
        [disabled]="!interactive()"
        [attr.aria-label]="accessibleLabel()"
        (click)="cycle.emit()"
      >
        <span class="lede" aria-hidden="true">{{ lede() }}</span>
        @if (parts().length > 0) {
          <span class="figure" aria-hidden="true" [attr.data-format]="format()">
            @for (part of parts(); track part.unit) {
              <span class="part">
                <span class="value hm-num">{{ part.value }}</span>
                <span class="unit">{{ part.unit }}</span>
              </span>
            }
          </span>
        } @else {
          <span class="figure figure--first" aria-hidden="true">{{ t.t('counter.firstDay') }}</span>
        }
        @if (secondary()) {
          <span class="secondary hm-num" aria-hidden="true">{{ secondary() }}</span>
        }
      </button>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .counter {
      appearance: none;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--hm-space-2);
      width: 100%;
      padding: var(--hm-space-2) 0;
      border: 0;
      background: none;
      color: var(--hm-ink);
      text-align: start;
      cursor: pointer;
      border-radius: var(--hm-radius-control);
      -webkit-tap-highlight-color: transparent;
    }
    .counter--static {
      cursor: default;
    }
    .counter:disabled {
      opacity: 1;
    }
    .lede {
      font-family: var(--hm-font-display);
      font-style: italic;
      font-size: var(--hm-text-lg);
      color: var(--hm-ink-muted);
    }
    .figure {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      column-gap: var(--hm-space-4);
      row-gap: 0;
      animation: hm-fade-in var(--hm-duration) var(--hm-ease);
    }
    .part {
      display: inline-flex;
      align-items: baseline;
      gap: 0.3rem;
    }
    .value {
      font-family: var(--hm-font-display);
      font-weight: 400;
      font-size: var(--hm-text-hero);
      line-height: 1.02;
      letter-spacing: -0.02em;
      color: var(--hm-berry);
      font-variation-settings: 'opsz' 144, 'SOFT' 60, 'WONK' 0;
    }
    .unit {
      font-family: var(--hm-font-display);
      font-style: italic;
      font-size: var(--hm-text-xl);
      color: var(--hm-ink);
    }
    .figure--first {
      font-family: var(--hm-font-display);
      font-size: var(--hm-text-3xl);
      line-height: 1.1;
      color: var(--hm-berry);
    }
    .secondary {
      font-size: var(--hm-text-md);
      color: var(--hm-ink-muted);
      letter-spacing: 0.01em;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CounterComponent {
  protected readonly t = inject(I18nService).translator;

  readonly counter = input.required<RelationshipCounter | null>();
  readonly format = input<CounterFormat>('calendar');
  readonly interactive = input(true);
  readonly cycle = output<void>();

  protected readonly lede = computed(() => this.t.t('counter.togetherFor'));

  protected readonly parts = computed<Part[]>(() => {
    const c = this.counter();
    if (!c || c.state !== 'counting') return [];
    const n = (value: number) => this.t.formatNumber(value);
    switch (this.format()) {
      case 'days':
        return c.totalDays === 0 ? [] : [{ value: n(c.totalDays), unit: this.t.plural('unit.day', c.totalDays) }];
      case 'weeks': {
        if (c.totalDays === 0) return [];
        const parts: Part[] = [];
        if (c.weeks > 0) parts.push({ value: n(c.weeks), unit: this.t.plural('unit.week', c.weeks) });
        if (c.weekRemainderDays > 0 || c.weeks === 0) {
          parts.push({ value: n(c.weekRemainderDays), unit: this.t.plural('unit.day', c.weekRemainderDays) });
        }
        return parts;
      }
      default:
        return calendarParts(this.t, c.calendar).map((p) => ({ value: n(p.value), unit: p.unit }));
    }
  });

  protected readonly secondary = computed(() => {
    const c = this.counter();
    if (!c || c.state !== 'counting' || c.totalDays === 0) return '';
    return this.format() === 'days'
      ? formatShortCalendarDuration(this.t, c.calendar)
      : this.t.plural('counter.daysTogether', c.totalDays);
  });

  protected readonly accessibleLabel = computed(() => {
    const c = this.counter();
    if (!c || c.state !== 'counting') return '';
    if (c.totalDays === 0) return this.t.t('counter.firstDay');
    const main =
      this.format() === 'weeks'
        ? formatWeeksAndDays(this.t, c.weeks, c.weekRemainderDays)
        : formatCalendarDuration(this.t, c.calendar);
    const sentence = this.t.t('counter.accessible', {
      duration: main,
      days: this.t.plural('counter.daysTogether', c.totalDays),
    });
    return this.interactive() ? `${sentence} ${this.t.t('home.counterHint')}` : sentence;
  });
}
