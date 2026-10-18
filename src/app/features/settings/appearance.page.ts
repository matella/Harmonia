import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { IonContent, IonToggle } from '@ionic/angular';

import type {
  AccentPreset,
  AppSettings,
  CounterFormat,
  LanguagePreference,
  LeapDayPolicy,
  ThemePreference,
  TogetherMonthsMode,
} from '../../core/domain/models';
import { I18nService } from '../../core/services/i18n.service';
import { NoticeService } from '../../core/services/notice.service';
import { SettingsService } from '../../core/services/settings.service';
import { AppStore } from '../../core/state/app-store';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { ChoiceListComponent, type Choice } from './choice-list.component';
import { SettingsHeaderComponent } from './settings-header.component';

@Component({
  selector: 'hm-appearance',
  imports: [IonContent, IonToggle, ChoiceListComponent, SettingsHeaderComponent, ...I18N_PIPES],
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
        <section class="hm-section" aria-labelledby="together-heading">
          <h2 id="together-heading" class="hm-section__title">{{ 'appearance.together' | t }}</h2>
          <p class="hm-section__hint">{{ 'appearance.togetherHint' | t }}</p>
          <hm-choice-list
            [label]="'appearance.together' | t"
            [choices]="togetherMonths()"
            [value]="settings().togetherMonths"
            (changed)="save({ togetherMonths: $event })"
          />
          <div class="hm-switch-row">
            <label class="hm-switch-row__text" for="a-together-days">
              {{ 'appearance.togetherDays' | t }}
              <span class="hm-switch-row__hint">{{ 'appearance.togetherDaysHint' | t }}</span>
            </label>
            <ion-toggle id="a-together-days" [checked]="settings().togetherDays" (ionChange)="save({ togetherDays: $event.detail.checked })" />
          </div>
        </section>
        <section class="hm-section">
          <h2 class="hm-section__title">{{ 'appearance.language' | t }}</h2>
          <p class="hm-section__hint">{{ 'appearance.languageHint' | t }}</p>
          <hm-choice-list [label]="'appearance.language' | t" [choices]="languages()" [value]="settings().language" (changed)="setLanguage($event)" />
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

  protected readonly togetherMonths = computed<Choice<TogetherMonthsMode>[]>(() => [
    { value: 'key', label: this.t.t('appearance.together.key'), hint: this.t.t('appearance.together.keyHint') },
    { value: 'every', label: this.t.t('appearance.together.every'), hint: this.t.t('appearance.together.everyHint') },
    { value: 'off', label: this.t.t('appearance.together.off') },
  ]);
  protected readonly languages = computed<Choice<LanguagePreference>[]>(() => [
    { value: 'system', label: this.t.t('appearance.language.system') },
    { value: 'en', label: this.t.t('language.en') },
    { value: 'fr', label: this.t.t('language.fr') },
    { value: 'nl', label: this.t.t('language.nl') },
  ]);

  /** Saves, then restarts the web layer so every screen, reminder and widget uses the new copy. */
  protected async setLanguage(language: LanguagePreference): Promise<void> {
    try {
      await this.service.update({ language });
      location.reload();
    } catch {
      await this.notice.show(this.t.t('settings.saveFailed'), 'warning');
    }
  }

  protected async save(changes: Partial<AppSettings>): Promise<void> {
    try {
      await this.service.update(changes);
    } catch {
      await this.notice.show(this.t.t('settings.saveFailed'), 'warning');
    }
  }
}
