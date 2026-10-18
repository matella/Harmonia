import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { IonContent } from '@ionic/angular';

import type { AccentPreset, AppSettings, CounterFormat, LeapDayPolicy, ThemePreference } from '../../core/domain/models';
import { I18nService } from '../../core/services/i18n.service';
import { NoticeService } from '../../core/services/notice.service';
import { SettingsService } from '../../core/services/settings.service';
import { AppStore } from '../../core/state/app-store';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { ChoiceListComponent, type Choice } from './choice-list.component';
import { SettingsHeaderComponent } from './settings-header.component';

@Component({
  selector: 'hm-appearance',
  imports: [IonContent, ChoiceListComponent, SettingsHeaderComponent, ...I18N_PIPES],
  template: `
    <hm-settings-header [title]="'appearance.title' | t" />
    <ion-content>
      <div class="hm-page">
        <section class="hm-section first">
          <h2 class="hm-section__title">{{ 'appearance.theme' | t }}</h2>
          <hm-choice-list [label]="'appearance.theme' | t" [choices]="themes()" [value]="settings().theme" (changed)="save({ theme: $event })" />
        </section>
        <section class="hm-section">
          <h2 class="hm-section__title">{{ 'appearance.accent' | t }}</h2>
          <div class="swatches" role="radiogroup" [attr.aria-label]="'appearance.accent' | t">
            @for (a of accents(); track a.value) {
              <button
                type="button"
                role="radio"
                class="swatch"
                [attr.data-accent]="a.value"
                [attr.aria-checked]="settings().accent === a.value"
                (click)="save({ accent: a.value })"
              >
                <span class="swatch__color" aria-hidden="true"></span>{{ a.label }}
              </button>
            }
          </div>
        </section>
        <section class="hm-section">
          <h2 class="hm-section__title">{{ 'appearance.counter' | t }}</h2>
          <hm-choice-list
            [label]="'appearance.counter' | t"
            [choices]="formats()"
            [value]="settings().counterFormat"
            (changed)="save({ counterFormat: $event })"
          />
        </section>
        <section class="hm-section">
          <h2 class="hm-section__title">{{ 'appearance.leap' | t }}</h2>
          <p class="hm-section__hint">{{ 'appearance.leapHint' | t }}</p>
          <hm-choice-list [label]="'appearance.leap' | t" [choices]="leap()" [value]="settings().leapDayPolicy" (changed)="save({ leapDayPolicy: $event })" />
        </section>
      </div>
    </ion-content>
  `,
  styles: `
    .first {
      margin-top: var(--hm-space-4);
    }
    .swatches {
      display: flex;
      gap: var(--hm-space-3);
    }
    .swatch {
      display: inline-flex;
      align-items: center;
      gap: var(--hm-space-2);
      min-height: var(--hm-tap);
      padding: 0 var(--hm-space-4) 0 var(--hm-space-2);
      border-radius: var(--hm-radius-pill);
      border: 1.5px solid var(--hm-line-strong);
      background: var(--hm-surface);
      color: var(--hm-ink);
      font: 500 var(--hm-text-sm) / 1 var(--hm-font-ui);
      cursor: pointer;
    }
    .swatch[aria-checked='true'] {
      border-color: var(--hm-ink);
    }
    .swatch__color {
      width: 28px;
      height: 28px;
      border-radius: 50%;
    }
    .swatch[data-accent='berry'] .swatch__color {
      background: linear-gradient(135deg, var(--hm-swatch-berry) 50%, var(--hm-swatch-berry-2) 50%);
    }
    .swatch[data-accent='sage'] .swatch__color {
      background: linear-gradient(135deg, var(--hm-swatch-sage) 50%, var(--hm-swatch-sage-2) 50%);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppearancePage {
  private readonly t = inject(I18nService).translator;
  private readonly store = inject(AppStore);
  private readonly service = inject(SettingsService);
  private readonly notice = inject(NoticeService);

  protected readonly settings = this.store.settings;

  protected readonly themes = computed<Choice<ThemePreference>[]>(() => [
    { value: 'system', label: this.t.t('appearance.theme.system') },
    { value: 'light', label: this.t.t('appearance.theme.light') },
    { value: 'dark', label: this.t.t('appearance.theme.dark') },
  ]);
  protected readonly accents = computed<Choice<AccentPreset>[]>(() => [
    { value: 'berry', label: this.t.t('appearance.accent.berry') },
    { value: 'sage', label: this.t.t('appearance.accent.sage') },
  ]);
  protected readonly formats = computed<Choice<CounterFormat>[]>(() => [
    { value: 'calendar', label: this.t.t('appearance.counter.calendar') },
    { value: 'days', label: this.t.t('appearance.counter.days') },
    { value: 'weeks', label: this.t.t('appearance.counter.weeks') },
  ]);
  protected readonly leap = computed<Choice<LeapDayPolicy>[]>(() => [
    { value: 'feb28', label: this.t.t('appearance.leap.feb28') },
    { value: 'mar1', label: this.t.t('appearance.leap.mar1') },
  ]);

  protected async save(changes: Partial<AppSettings>): Promise<void> {
    try {
      await this.service.update(changes);
    } catch {
      await this.notice.show(this.t.t('settings.saveFailed'), 'warning');
    }
  }
}
