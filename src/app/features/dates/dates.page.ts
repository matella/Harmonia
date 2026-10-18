import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import { I18nService } from '../../core/services/i18n.service';
import { ReminderService } from '../../core/services/reminder.service';
import { AppStore } from '../../core/state/app-store';
import { EmptyStateComponent } from '../../shared/components/empty-state.component';
import { MilestoneRowComponent } from '../../shared/components/milestone-row.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { reminderStateFor } from '../../shared/utilities/reminder-state';

type Filter = 'all' | 'upcoming' | 'past' | 'annual';

@Component({
  selector: 'hm-dates',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonIcon,
    IonContent,
    IonSegment,
    IonSegmentButton,
    EmptyStateComponent,
    MilestoneRowComponent,
    ...I18N_PIPES,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-title>{{ 'dates.title' | t }}</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="add()" [attr.aria-label]="'dates.add' | t">
            <ion-icon slot="icon-only" name="add" aria-hidden="true" />
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <div class="hm-page">
        @if (store.milestones().length === 0) {
          <hm-empty-state
            icon="calendar-outline"
            [title]="'dates.emptyTitle' | t"
            [body]="'dates.emptyBody' | t"
            [actionLabel]="'dates.add' | t"
            (action)="add()"
          />
        } @else {
          <ion-segment
            [value]="filter()"
            (ionChange)="filter.set($any($event.detail.value))"
            [attr.aria-label]="'dates.filter' | t"
          >
            <ion-segment-button value="all">{{ 'dates.filter.all' | t }}</ion-segment-button>
            <ion-segment-button value="upcoming">{{ 'dates.filter.upcoming' | t }}</ion-segment-button>
            <ion-segment-button value="past">{{ 'dates.filter.past' | t }}</ion-segment-button>
            <ion-segment-button value="annual">{{ 'dates.filter.annual' | t }}</ion-segment-button>
          </ion-segment>

          @if (showUpcoming()) {
            <section class="hm-section first" aria-labelledby="upcoming-heading">
              <h2 id="upcoming-heading" class="hm-section__title">
                {{ (filter() === 'annual' ? 'dates.annual' : 'dates.upcoming') | t }}
              </h2>
              @if (upcoming().length > 0) {
                <ul class="hm-rows">
                  @for (o of upcoming(); track o.milestone.id) {
                    <li><hm-milestone-row [occurrence]="o" [reminderState]="reminderState(o.milestone.id)" /></li>
                  }
                </ul>
              } @else {
                <p class="hm-section__hint">{{ 'dates.emptyFilter' | t }}</p>
              }
            </section>
          }

          @if (showPast() && store.past().length > 0) {
            <section class="hm-section" aria-labelledby="past-heading">
              <div class="hm-section__head">
                <h2 id="past-heading" class="hm-section__title">{{ 'dates.past' | t }}</h2>
                @if (filter() === 'all') {
                  <button type="button" class="hm-link-button" [attr.aria-expanded]="pastOpen()" aria-controls="past-list" (click)="pastOpen.set(!pastOpen())">
                    {{ pastOpen() ? ('dates.hidePast' | t) : ('dates.showPast' | tp: store.past().length) }}
                  </button>
                }
              </div>
              @if (pastOpen() || filter() === 'past') {
                <ul class="hm-rows" id="past-list">
                  @for (o of store.past(); track o.milestone.id) {
                    <li><hm-milestone-row [occurrence]="o" [reminderState]="reminderState(o.milestone.id)" /></li>
                  }
                </ul>
              }
            </section>
          } @else if (filter() === 'past') {
            <p class="hm-section__hint hm-section">{{ 'dates.emptyFilter' | t }}</p>
          }
        }
      </div>
    </ion-content>
  `,
  styles: `
    ion-segment {
      margin-top: var(--hm-space-2);
    }
    .first {
      margin-top: var(--hm-space-6);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DatesPage {
  protected readonly store = inject(AppStore);
  protected readonly t = inject(I18nService).translator;
  private readonly reminders = inject(ReminderService);
  private readonly router = inject(Router);

  protected readonly filter = signal<Filter>('all');
  protected readonly pastOpen = signal(false);

  protected readonly showUpcoming = computed(() => this.filter() !== 'past');
  protected readonly showPast = computed(() => this.filter() === 'all' || this.filter() === 'past');

  protected readonly upcoming = computed(() => {
    const list = this.store.upcoming();
    return this.filter() === 'annual' ? list.filter((o) => o.milestone.recurrence === 'yearly') : list;
  });

  protected reminderState(milestoneId: string) {
    return reminderStateFor(milestoneId, this.store.rulesByMilestone(), this.store.settings(), this.reminders.permission());
  }

  protected add(): void {
    void this.router.navigateByUrl('/milestone/new');
  }
}
