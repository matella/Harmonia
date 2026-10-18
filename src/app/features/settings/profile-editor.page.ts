import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { IonButton, IonButtons, IonContent, IonIcon, IonToggle, NavController } from '@ionic/angular';

import { validateProfile } from '../../core/domain/validation';
import { MediaStorageService } from '../../core/platform/media-storage.service';
import { I18nService } from '../../core/services/i18n.service';
import { NoticeService } from '../../core/services/notice.service';
import { ProfileService, type PhotoChange } from '../../core/services/profile.service';
import { CLOCK } from '../../core/services/tokens';
import { AppStore } from '../../core/state/app-store';
import { DateFieldComponent } from '../../shared/components/date-field.component';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { PendingPhoto } from '../../shared/utilities/local-photo';
import { validationMessage } from '../../shared/utilities/validation-messages';
import { SettingsHeaderComponent } from './settings-header.component';

/** Edit every onboarding value later: start date/time, name, label, photo, day-counting zone. */
@Component({
  selector: 'hm-profile-editor',
  imports: [
    IonButtons,
    IonButton,
    IonContent,
    IonIcon,
    IonToggle,
    DateFieldComponent,
    PhotoFrameComponent,
    SettingsHeaderComponent,
    ...I18N_PIPES,
  ],
  template: `
    <hm-settings-header [title]="'profile.title' | t">
      <ion-buttons slot="end">
        <ion-button [strong]="true" [disabled]="saving()" (click)="save()">{{ 'common.save' | t }}</ion-button>
      </ion-buttons>
    </hm-settings-header>
    <ion-content>
      <div class="hm-page">
        <form class="hm-form" (submit)="save(); $event.preventDefault()" novalidate>
          <div class="photo">
            <hm-photo-frame class="photo__frame" shape="round" [src]="photo.url()" [path]="currentPhoto()" [alt]="'home.photoAlt' | t" [emblemSize]="30" />
            <div class="photo__actions">
              <button type="button" class="hm-btn hm-btn--outline" (click)="choosePhoto()">
                <ion-icon name="image-outline" aria-hidden="true" />{{ (hasPhoto() ? 'photo.change' : 'photo.choose') | t }}
              </button>
              @if (hasPhoto()) {
                <button type="button" class="hm-btn hm-btn--quiet" (click)="removePhoto()">{{ 'photo.remove' | t }}</button>
              }
            </div>
          </div>

          <div class="hm-field">
            <label class="hm-field__label" for="p-name">
              {{ 'onboarding.nameLabel' | t }} <span class="hm-field__optional">{{ 'common.optional' | t }}</span>
            </label>
            <input id="p-name" class="hm-input" type="text" maxlength="60" autocapitalize="words" [value]="name()" (input)="name.set($any($event.target).value)" />
            @if (errors().displayName) {
              <span class="hm-field__error" role="alert">{{ errors().displayName }}</span>
            }
          </div>

          <div class="hm-field">
            <label class="hm-field__label" for="p-label">
              {{ 'profile.labelLabel' | t }} <span class="hm-field__optional">{{ 'common.optional' | t }}</span>
            </label>
            <input
              id="p-label"
              class="hm-input"
              type="text"
              maxlength="40"
              [placeholder]="'profile.labelPlaceholder' | t"
              [value]="label()"
              (input)="label.set($any($event.target).value)"
            />
            @if (errors().relationshipLabel) {
              <span class="hm-field__error" role="alert">{{ errors().relationshipLabel }}</span>
            }
          </div>

          <hm-date-field
            [label]="'onboarding.startDateLabel' | t"
            [(value)]="startDate"
            [max]="store.today().toString()"
            [hint]="'profile.startDateHint' | t"
            [error]="errors().startDate"
          />

          <div class="hm-switch-row">
            <label class="hm-switch-row__text" for="p-time">
              {{ 'onboarding.addTime' | t }}
              <span class="hm-switch-row__hint">{{ 'onboarding.addTimeHint' | t }}</span>
            </label>
            <ion-toggle id="p-time" [checked]="withTime()" (ionChange)="withTime.set($event.detail.checked)" />
          </div>
          @if (withTime()) {
            <hm-date-field mode="time" [label]="'onboarding.startTimeLabel' | t" [(value)]="startTime" [error]="errors().startTime" />
          }

          <div class="hm-field">
            <span class="hm-field__label">{{ 'profile.timeZoneLabel' | t }}</span>
            <p class="hm-field__hint">{{ 'profile.timeZoneHint' | t: { zone: calendarZone() } }}</p>
            @if (calendarZone() !== store.deviceTimeZone()) {
              <button type="button" class="hm-btn hm-btn--outline" (click)="calendarZone.set(store.deviceTimeZone())">
                {{ 'profile.useCurrentZone' | t: { zone: store.deviceTimeZone() } }}
              </button>
            }
          </div>

          <button type="submit" class="hm-btn hm-btn--block" [disabled]="saving()">
            {{ (saving() ? 'common.saving' : 'common.save') | t }}
          </button>
        </form>
      </div>
    </ion-content>
  `,
  styles: `
    .hm-form {
      padding-top: var(--hm-space-4);
    }
    .photo {
      display: flex;
      align-items: center;
      gap: var(--hm-space-5);
    }
    .photo__frame {
      width: 96px;
      flex: none;
    }
    .photo__actions {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--hm-space-1);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileEditorPage implements OnInit, OnDestroy {
  protected readonly t = inject(I18nService).translator;
  protected readonly store = inject(AppStore);
  private readonly profiles = inject(ProfileService);
  private readonly media = inject(MediaStorageService);
  private readonly notice = inject(NoticeService);
  private readonly nav = inject(NavController);
  private readonly clock = inject(CLOCK);

  protected readonly name = signal('');
  protected readonly label = signal('');
  protected readonly startDate = signal<string | null>(null);
  protected readonly withTime = signal(false);
  protected readonly startTime = signal<string | null>(null);
  protected readonly startZone = signal<string | null>(null);
  protected readonly calendarZone = signal('');
  protected readonly photo = new PendingPhoto();
  protected readonly photoRemoved = signal(false);
  protected readonly saving = signal(false);
  protected readonly attempted = signal(false);

  protected readonly currentPhoto = computed(() => (this.photoRemoved() ? null : (this.store.profile()?.photoPath ?? null)));
  protected readonly hasPhoto = computed(() => !!this.photo.url() || !!this.currentPhoto());

  private readonly result = computed(() =>
    validateProfile(
      {
        displayName: this.name(),
        relationshipLabel: this.label(),
        startDate: this.startDate() ?? '',
        startTime: this.withTime() ? this.startTime() : null,
        // Keep the zone the time was originally entered in; a newly added time uses the device zone.
        startTimeZoneId: this.startZone() ?? this.clock.timeZoneId(),
        calendarTimeZoneId: this.calendarZone(),
      },
      this.store.today(),
    ),
  );

  protected readonly errors = computed<Record<'displayName' | 'relationshipLabel' | 'startDate' | 'startTime', string | null>>(() => {
    const r = this.result();
    if (r.ok) return { displayName: null, relationshipLabel: null, startDate: null, startTime: null };
    return {
      displayName: validationMessage(this.t, r.errors.displayName),
      relationshipLabel: validationMessage(this.t, r.errors.relationshipLabel),
      startDate: this.attempted() || r.errors.startDate === 'futureDate' ? validationMessage(this.t, r.errors.startDate, 'startDate') : null,
      startTime: this.attempted() ? validationMessage(this.t, r.errors.startTime) : null,
    };
  });

  ngOnInit(): void {
    const p = this.store.profile();
    if (!p) return;
    this.name.set(p.displayName ?? '');
    this.label.set(p.relationshipLabel ?? '');
    this.startDate.set(p.startDate);
    this.withTime.set(!!p.startTime);
    this.startTime.set(p.startTime);
    this.startZone.set(p.startTimeZoneId);
    this.calendarZone.set(p.calendarTimeZoneId);
  }

  ngOnDestroy(): void {
    this.photo.clear();
  }

  protected async choosePhoto(): Promise<void> {
    const [image] = await this.media.pickImages(false);
    if (image) {
      this.photo.set(image);
      this.photoRemoved.set(false);
    }
  }

  protected removePhoto(): void {
    this.photo.clear();
    this.photoRemoved.set(true);
  }

  protected async save(): Promise<void> {
    this.attempted.set(true);
    const result = this.result();
    if (!result.ok || this.saving()) return;
    this.saving.set(true);
    const blob = this.photo.blob;
    const change: PhotoChange = blob ? { kind: 'set', image: blob } : this.photoRemoved() ? { kind: 'remove' } : { kind: 'keep' };
    try {
      await this.profiles.save(result.value, change);
      await this.notice.show(this.t.t('profile.saved'));
      this.nav.back();
    } catch {
      await this.notice.show(this.t.t('onboarding.saveFailed'), 'warning');
    } finally {
      this.saving.set(false);
    }
  }
}
