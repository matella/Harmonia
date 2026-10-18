import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** Accessible single-choice list (radiogroup) used by settings pages. */
@Component({
  selector: 'hm-choice-list',
  template: `
    <div role="radiogroup" [attr.aria-label]="label()">
      @for (choice of choices(); track choice.value) {
        <button
          type="button"
          role="radio"
          class="hm-choice"
          [attr.aria-checked]="choice.value === value()"
          (click)="choice.value !== value() && changed.emit(choice.value)"
        >
          <span class="hm-choice__mark" aria-hidden="true"></span>
          <span class="hm-choice__text">
            {{ choice.label }}
            @if (choice.hint) {
              <span class="hm-choice__hint">{{ choice.hint }}</span>
            }
          </span>
        </button>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChoiceListComponent<T extends string = string> {
  readonly label = input.required<string>();
  readonly choices = input.required<Choice<T>[]>();
  readonly value = input.required<T>();
  readonly changed = output<T>();
}
