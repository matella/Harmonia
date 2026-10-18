import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { IonContent, IonIcon } from '@ionic/angular';

import type { AppSettings, WidgetPrivacyMode } from '../../core/domain/models';
import { I18nService } from '../../core/services/i18n.service';
import { NoticeService } from '../../core/services/notice.service';
import { SettingsService } from '../../core/services/settings.service';
import { WidgetService } from '../../core/services/widget.service';
import { AppStore } from '../../core/state/app-store';
import { WidgetPreviewComponent } from '../../shared/components/widget-preview.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { ChoiceListComponent, type Choice } from './choice-list.component';
import { SettingsHeaderComponent } from './settings-header.component';

@Component({
  selector: 'hm-widget-settings',
  imports: [IonContent, IonIcon, ChoiceListComponent, SettingsHeaderComponent, WidgetPreviewComponent, ...I18N_PIPES],
  template: `
    <hm-settings-header [title]="'widgets.title' | t" />
    <ion-content>
      <div class="hm-page">
        <section class="hm-section first" aria-labelledby="preview-heading">
          <h2 id="preview-heading" class="hm-section__title">{{ 'widgets.preview' | t }}</h2>
          <hm-widget-preview [snapshot]="snapshot()" [today]="store.today()" />
        </section>
        <section class="hm-section">
          <h2 class="hm-section__title">{{ 'widgets.privacy' | t }}</h2>
          <hm-choice-list [label]="'widgets.privacy' | t" [choices]="privacy()" [value]="settings().widgetPrivacy" (changed)="save({ widgetPrivacy: $event })" />
        </section>
        @if (settings().widgetPrivacy !== 'minimal') {
          <section class="hm-section">
            <h2 class="hm-section__title">{{ 'widgets.counter' | t }}</h2>
            <hm-choice-list
              [label]="'widgets.counter' | t"
              [choices]="counters()"
              [value]="settings().widgetCounterMode"
              (changed)="save({ widgetCounterMode: $event })"
            />
          </section>
        }
        <section class="hm-section notes">
          <p class="hm-callout"><ion-icon name="grid-outline" aria-hidden="true" /><span>{{ 'widgets.howTo' | t }}</span></p>
          <p class="hm-callout"><ion-icon name="watch-outline" aria-hidden="true" /><span>{{ 'widgets.watchNote' | t }}</span></p>
        </section>
      </div>
    </ion-content>
  `,
  styles: `
    .first {
      margin-top: var(--hm-space-4);
    }
    .notes {
      display: flex;
      flex-direction: column;
      gap: var(--hm-space-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WidgetSettingsPage {
  private readonly t = inject(I18nService).translator;
  protected readonly store = inject(AppStore);
  private readonly service = inject(SettingsService);
  private readonly widgets = inject(WidgetService);
  private readonly notice = inject(NoticeService);

  protected readonly settings = this.store.settings;
  /** Recomputed whenever profile, milestones or settings change (same builder as native). */
  protected readonly snapshot = computed(() => {
    this.store.profile();
    this.store.milestones();
    this.store.settings();
    this.store.now();
    return this.widgets.current();
  });

  protected readonly privacy = computed<Choice<WidgetPrivacyMode>[]>(() => [
    { value: 'normal', label: this.t.t('widgets.privacy.normal'), hint: this.t.t('widgets.privacy.normalHint') },
    { value: 'discreet', label: this.t.t('widgets.privacy.discreet'), hint: this.t.t('widgets.privacy.discreetHint') },
    { value: 'minimal', label: this.t.t('widgets.privacy.minimal'), hint: this.t.t('widgets.privacy.minimalHint') },
  ]);
  protected readonly counters = computed<Choice<'days' | 'calendar'>[]>(() => [
    { value: 'days', label: this.t.t('widgets.counter.days') },
    { value: 'calendar', label: this.t.t('widgets.counter.calendar') },
  ]);

  protected async save(changes: Partial<AppSettings>): Promise<void> {
    try {
      await this.service.update(changes);
    } catch {
      await this.notice.show(this.t.t('settings.saveFailed'), 'warning');
    }
  }
}
