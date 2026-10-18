import { ChangeDetectionStrategy, Component, computed, inject, input, model, signal } from '@angular/core';
import { IonDatetime, IonIcon, IonModal } from '@ionic/angular';

import { isValidIsoDate, isValidLocalTime, toPlainDate } from '../../core/domain/local-date';
import { I18nService } from '../../core/services/i18n.service';

let nextId = 0;

/**
 * Date or time picker field. Values are plain `YYYY-MM-DD` / `HH:mm` strings: the
 * picker's output is sliced, never converted through Date, so no time zone can shift it.
 * Errors are rendered next to the field and announced (role="alert").
 */
@Component({
  selector: 'hm-date-field',
  imports: [IonModal, IonDatetime, IonIcon],
  template: `
    <div class="hm-field">
      <span class="hm-field__label" [id]="labelId">
        {{ label() }}
        @if (optional()) {
          <span class="hm-field__optional">{{ t.t('common.optional') }}</span>
        }
      </span>
      <button
        type="button"
        class="hm-input"
        [attr.aria-labelledby]="labelId + ' ' + valueId"
        [attr.aria-invalid]="error() ? 'true' : null"
        [attr.aria-describedby]="error() ? errorId : hint() ? hintId : null"
        (click)="open.set(true)"
      >
        <span [id]="valueId" [class.hm-input__placeholder]="!value()">{{ display() }}</span>
        <ion-icon [name]="mode() === 'time' ? 'time-outline' : 'calendar-outline'" aria-hidden="true" />
      </button>
      @if (hint() && !error()) {
        <span class="hm-field__hint" [id]="hintId">{{ hint() }}</span>
      }
      @if (error()) {
        <span class="hm-field__error" [id]="errorId" role="alert">
          <ion-icon name="alert-circle-outline" aria-hidden="true" />{{ error() }}
        </span>
      }
    </div>

    <ion-modal class="hm-datetime-modal" [isOpen]="open()" (didDismiss)="open.set(false)">
      <ng-template>
        <ion-datetime
          [presentation]="mode()"
          [value]="pickerValue()"
          [min]="min() || undefined"
          [max]="max() || undefined"
          [showDefaultButtons]="true"
          [showClearButton]="optional()"
          [doneText]="t.t('common.done')"
          [cancelText]="t.t('common.cancel')"
          [clearText]="t.t('common.clear')"
          [locale]="t.locale"
          [preferWheel]="mode() === 'time'"
          (ionChange)="onPick($event.detail.value)"
        />
      </ng-template>
    </ion-modal>
  `,
  styles: `
    :host {
      display: block;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DateFieldComponent {
  protected readonly t = inject(I18nService).translator;

  readonly label = input.required<string>();
  readonly mode = input<'date' | 'time'>('date');
  readonly value = model<string | null>(null);
  readonly min = input<string | null>(null);
  readonly max = input<string | null>(null);
  readonly optional = input(false);
  readonly placeholder = input('');
  readonly hint = input('');
  readonly error = input<string | null>(null);

  protected readonly open = signal(false);
  private readonly uid = ++nextId;
  protected readonly labelId = `hm-date-label-${this.uid}`;
  protected readonly valueId = `hm-date-value-${this.uid}`;
  protected readonly hintId = `hm-date-hint-${this.uid}`;
  protected readonly errorId = `hm-date-error-${this.uid}`;

  protected readonly display = computed(() => {
    const value = this.value();
    if (this.mode() === 'time') return value && isValidLocalTime(value) ? this.t.formatTime(value) : this.placeholder() || this.t.t('common.chooseTime');
    return value && isValidIsoDate(value) ? this.t.formatDate(toPlainDate(value), 'full') : this.placeholder() || this.t.t('common.chooseDate');
  });

  protected readonly pickerValue = computed(() => {
    const value = this.value();
    if (!value) return undefined;
    return this.mode() === 'time' ? `2000-01-01T${value}:00` : value;
  });

  protected onPick(raw: string | string[] | null | undefined): void {
    const text = Array.isArray(raw) ? raw[0] : raw;
    if (!text) {
      this.value.set(null);
      return;
    }
    if (this.mode() === 'time') {
      const match = /T?(\d{2}:\d{2})/.exec(text.includes('T') ? text.split('T')[1] : text);
      this.value.set(match ? match[1] : null);
    } else {
      this.value.set(text.slice(0, 10));
    }
  }
}
