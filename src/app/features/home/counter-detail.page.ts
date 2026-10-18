import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';

import { fixedClock } from '../../core/domain/clock';
import type { CounterFormat } from '../../core/domain/models';
import { computeRelationshipCounter } from '../../core/domain/relationship-duration';
import {
  formatCalendarDuration,
  formatPreciseDuration,
  formatWeeksAndDays,
} from '../../core/i18n/duration-format';
import { I18nService } from '../../core/services/i18n.service';
import { SettingsService } from '../../core/services/settings.service';
import { CLOCK } from '../../core/services/tokens';
import { AppStore } from '../../core/state/app-store';
import { CounterComponent } from '../../shared/components/counter.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';

/**
 * Every counter format side by side. With an exact start time, the precise duration
 * updates once per second — only while this screen is visible and the app is in the
 * foreground.
 */
@Component({
  selector: 'hm-counter-detail',
  imports: [IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, CounterComponent, ...I18N_PIPES],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/home" [text]="''" /></ion-buttons>
        <ion-title>{{ 'counterDetail.title' | t }}</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <div class="hm-page">
        @let p = store.profile();
        @let c = counter();
        @if (p && c && c.state === 'counting') {
          <hm-counter [counter]="c" [format]="'calendar'" [interactive]="false" />
          <p class="since">
            @if (p.startTime) {
              {{ 'counterDetail.sinceWithTime' | t: { date: (p.startDate | hmDate: 'long'), time: (p.startTime | hmTime) } }}
            } @else {
              {{ 'counterDetail.since' | t: { date: (p.startDate | hmDate: 'long') } }}
            }
          </p>

          <dl class="formats">
            @for (row of rows(); track row.format) {
              <div class="format">
                <dt>{{ row.label }}</dt>
                <dd class="hm-num">{{ row.value }}</dd>
                <button
                  type="button"
                  class="hm-chip"
                  [attr.aria-pressed]="store.settings().counterFormat === row.format"
                  (click)="makeDefault(row.format)"
                >
                  {{ (store.settings().counterFormat === row.format ? 'counterDetail.isDefault' : 'counterDetail.showAsDefault') | t }}
                </button>
              </div>
            }
            <div class="format">
              <dt>{{ 'counterDetail.precise' | t }}</dt>
              @if (c.precise) {
                <dd class="hm-num precise" aria-live="off">{{ precise() }}</dd>
              } @else {
                <dd class="hm-muted unavailable">{{ 'counter.preciseUnavailable' | t }}</dd>
              }
            </div>
          </dl>
        }
      </div>
    </ion-content>
  `,
  styles: `
    .since {
      margin-top: var(--hm-space-3);
      color: var(--hm-ink-muted);
      font-size: var(--hm-text-sm);
    }
    .formats {
      margin: var(--hm-space-10) 0 0;
    }
    .format {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: var(--hm-space-1) var(--hm-space-3);
      padding: var(--hm-space-4) 0;
      border-top: var(--hm-hairline);
    }
    dt {
      grid-column: 1 / -1;
      font-size: var(--hm-text-sm);
      color: var(--hm-ink-muted);
    }
    dd {
      margin: 0;
      font-family: var(--hm-font-display);
      font-size: var(--hm-text-xl);
      color: var(--hm-ink);
    }
    dd.unavailable {
      grid-column: 1 / -1;
      font-family: var(--hm-font-ui);
      font-size: var(--hm-text-md);
    }
    .precise {
      grid-column: 1 / -1;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CounterDetailPage implements OnDestroy {
  protected readonly store = inject(AppStore);
  private readonly clock = inject(CLOCK);
  private readonly settings = inject(SettingsService);
  private readonly t = inject(I18nService).translator;

  private readonly now = signal(this.clock.now());
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onVisibility = () => (document.visibilityState === 'visible' ? this.startTicking() : this.stopTicking());

  protected readonly counter = computed(() => {
    const profile = this.store.profile();
    return profile ? computeRelationshipCounter(profile, fixedClock(this.now().toString(), this.clock.timeZoneId())) : null;
  });

  protected readonly rows = computed(() => {
    const c = this.counter();
    if (!c || c.state !== 'counting') return [];
    return [
      {
        format: 'calendar' as CounterFormat,
        label: this.t.t('counterDetail.calendar'),
        value: c.totalDays === 0 ? this.t.t('counterDetail.dayZero') : formatCalendarDuration(this.t, c.calendar),
      },
      { format: 'days' as CounterFormat, label: this.t.t('counterDetail.totalDays'), value: this.t.plural('phrase.days', c.totalDays) },
      {
        format: 'weeks' as CounterFormat,
        label: this.t.t('counterDetail.weeks'),
        value: formatWeeksAndDays(this.t, c.weeks, c.weekRemainderDays),
      },
    ];
  });

  protected readonly precise = computed(() => {
    const c = this.counter();
    return c?.state === 'counting' && c.precise ? formatPreciseDuration(this.t, c.precise, true) : '';
  });

  ionViewDidEnter(): void {
    document.addEventListener('visibilitychange', this.onVisibility);
    this.startTicking();
  }

  ionViewWillLeave(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopTicking();
  }

  ngOnDestroy(): void {
    this.ionViewWillLeave();
  }

  protected async makeDefault(format: CounterFormat): Promise<void> {
    await this.settings.update({ counterFormat: format }).catch(() => undefined);
  }

  private startTicking(): void {
    this.now.set(this.clock.now());
    if (this.timer || !this.store.profile()?.startTime) return;
    this.timer = setInterval(() => this.now.set(this.clock.now()), 1000);
  }

  private stopTicking(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
