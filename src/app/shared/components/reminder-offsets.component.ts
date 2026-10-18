import { ChangeDetectionStrategy, Component, computed, inject, input, model, signal } from '@angular/core';
import { IonIcon } from '@ionic/angular';

import { MAX_REMINDER_OFFSET_DAYS, PRESET_REMINDER_OFFSETS } from '../../core/domain/models';
import { isValidReminderOffset } from '../../core/domain/validation';
import { I18nService } from '../../core/services/i18n.service';
import { OffsetLabelPipe } from '../pipes/i18n.pipes';

/**
 * Multi-select for "days before" reminder offsets: one-tap presets (on the day, 1, 3,
 * 7 days before) plus any custom number of days.
 */
@Component({
  selector: 'hm-reminder-offsets',
  imports: [IonIcon, OffsetLabelPipe],
  template: `
    <div class="hm-chips" role="group" [attr.aria-label]="label()">
      @for (offset of choices(); track offset) {
        <button type="button" class="hm-chip" [attr.aria-pressed]="selected().includes(offset)" (click)="toggle(offset)">
          @if (selected().includes(offset)) {
            <ion-icon name="checkmark" aria-hidden="true" />
          }
          {{ offset | offsetLabel }}
        </button>
      }
      @if (!customOpen()) {
        <button type="button" class="hm-chip" (click)="customOpen.set(true)">
          <ion-icon name="add" aria-hidden="true" />{{ t.t('reminder.custom') }}
        </button>
      }
    </div>
    @if (customOpen()) {
      <div class="custom">
        <label class="hm-field__label" for="hm-custom-offset">{{ t.t('reminder.customLabel') }}</label>
        <div class="custom__row">
          <input
            id="hm-custom-offset"
            class="hm-input hm-num"
            type="number"
            inputmode="numeric"
            min="0"
            [max]="max"
            [value]="customValue()"
            [attr.aria-invalid]="customError() ? 'true' : null"
            (input)="customValue.set($any($event.target).value)"
            (keydown.enter)="addCustom(); $event.preventDefault()"
          />
          <button type="button" class="hm-btn hm-btn--outline" (click)="addCustom()">{{ t.t('reminder.addCustom') }}</button>
        </div>
        @if (customError()) {
          <span class="hm-field__error" role="alert">{{ t.t('validation.invalidOffset') }}</span>
        }
      </div>
    }
  `,
  styles: `
    .custom {
      display: flex;
      flex-direction: column;
      gap: var(--hm-space-2);
      margin-top: var(--hm-space-3);
    }
    .custom__row {
      display: flex;
      gap: var(--hm-space-2);
    }
    .custom__row .hm-input {
      max-width: 8rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReminderOffsetsComponent {
  protected readonly t = inject(I18nService).translator;
  protected readonly max = MAX_REMINDER_OFFSET_DAYS;

  readonly selected = model<number[]>([]);
  readonly label = input('');

  protected readonly customOpen = signal(false);
  protected readonly customValue = signal('');
  protected readonly customError = signal(false);

  /** Presets plus any custom offsets already selected, sorted. */
  protected readonly choices = computed(() =>
    [...new Set<number>([...PRESET_REMINDER_OFFSETS, ...this.selected()])].sort((a, b) => a - b),
  );

  protected toggle(offset: number): void {
    const current = this.selected();
    this.selected.set(current.includes(offset) ? current.filter((o) => o !== offset) : [...current, offset].sort((a, b) => b - a));
  }

  protected addCustom(): void {
    const value = Number(this.customValue());
    if (this.customValue().trim() === '' || !isValidReminderOffset(value)) {
      this.customError.set(true);
      return;
    }
    this.customError.set(false);
    if (!this.selected().includes(value)) this.selected.set([...this.selected(), value].sort((a, b) => b - a));
    this.customValue.set('');
    this.customOpen.set(false);
  }
}
