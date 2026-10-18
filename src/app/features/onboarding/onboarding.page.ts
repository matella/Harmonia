import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonIcon, IonToggle } from '@ionic/angular';

import { validateMilestone, validateProfile } from '../../core/domain/validation';
import { MediaStorageService } from '../../core/platform/media-storage.service';
import { I18nService } from '../../core/services/i18n.service';
import { MilestoneService } from '../../core/services/milestone.service';
import { NoticeService } from '../../core/services/notice.service';
import { ProfileService } from '../../core/services/profile.service';
import { CLOCK } from '../../core/services/tokens';
import { UsageService } from '../../core/services/usage.service';
import { AppStore } from '../../core/state/app-store';
import { DateFieldComponent } from '../../shared/components/date-field.component';
import { EmblemComponent } from '../../shared/components/emblem.component';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { PendingPhoto } from '../../shared/utilities/local-photo';
import { validationMessage } from '../../shared/utilities/validation-messages';

type Step = 'welcome' | 'start' | 'partner' | 'anniversary';
const STEPS: Step[] = ['welcome', 'start', 'partner', 'anniversary'];

/**
 * First launch: a calm welcome, the start date (required, optional time), an optional
 * name and photo, and an optional yearly anniversary. No account and no permission
 * prompt unless the user opts into a reminder.
 */
@Component({
  selector: 'hm-onboarding',
  imports: [FormsModule, IonContent, IonIcon, IonToggle, DateFieldComponent, EmblemComponent, PhotoFrameComponent, ...I18N_PIPES],
  templateUrl: './onboarding.page.html',
  styleUrl: './onboarding.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OnboardingPage implements OnDestroy {
  protected readonly t = inject(I18nService).translator;
  private readonly clock = inject(CLOCK);
  private readonly store = inject(AppStore);
  private readonly profiles = inject(ProfileService);
  private readonly milestones = inject(MilestoneService);
  private readonly media = inject(MediaStorageService);
  private readonly notice = inject(NoticeService);
  private readonly router = inject(Router);
  private readonly usage = inject(UsageService);

  protected readonly step = signal<Step>('welcome');
  protected readonly stepNumber = computed(() => STEPS.indexOf(this.step()));
  protected readonly total = STEPS.length - 1;

  protected readonly startDate = signal<string | null>(null);
  protected readonly withTime = signal(false);
  protected readonly startTime = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly photo = new PendingPhoto();
  protected readonly remind = signal(false);
  protected readonly saving = signal(false);
  protected readonly attempted = signal(false);

  protected readonly today = computed(() => this.store.today().toString());

  private readonly profileResult = computed(() =>
    validateProfile(
      {
        displayName: this.name(),
        relationshipLabel: null,
        startDate: this.startDate() ?? '',
        startTime: this.withTime() ? this.startTime() : null,
        startTimeZoneId: this.clock.timeZoneId(),
        calendarTimeZoneId: this.clock.timeZoneId(),
      },
      this.store.today(),
    ),
  );

  protected readonly startDateError = computed(() => {
    const result = this.profileResult();
    if (result.ok || !this.attempted()) return null;
    return validationMessage(this.t, result.errors.startDate, 'startDate');
  });
  protected readonly startTimeError = computed(() => {
    const result = this.profileResult();
    if (result.ok || !this.attempted()) return null;
    return validationMessage(this.t, result.errors.startTime);
  });
  protected readonly nameError = computed(() => {
    const result = this.profileResult();
    return result.ok ? null : validationMessage(this.t, result.errors.displayName);
  });

  ngOnDestroy(): void {
    this.photo.clear();
  }

  protected next(): void {
    const step = this.step();
    if (step === 'start') {
      this.attempted.set(true);
      const result = this.profileResult();
      if (!result.ok && (result.errors.startDate || result.errors.startTime)) return;
    }
    if (step === 'partner' && this.nameError()) return;
    this.step.set(STEPS[Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1)]);
  }

  protected back(): void {
    this.step.set(STEPS[Math.max(this.stepNumber() - 1, 0)]);
  }

  protected async choosePhoto(): Promise<void> {
    const [image] = await this.media.pickImages(false);
    if (image) this.photo.set(image);
  }

  protected async finish(addAnniversary: boolean): Promise<void> {
    const result = this.profileResult();
    if (!result.ok || this.saving()) return;
    this.saving.set(true);
    try {
      const blob = this.photo.blob;
      await this.profiles.save(result.value, blob ? { kind: 'set', image: blob } : { kind: 'keep' });
      if (addAnniversary) {
        const settings = this.store.settings();
        const milestone = validateMilestone({
          title: this.t.t('onboarding.anniversaryTitle'),
          category: 'anniversary',
          eventDate: result.value.startDate,
          eventTime: null,
          recurrence: 'yearly',
          leapDayPolicy: null,
          note: null,
          isPinned: false,
          remindersEnabled: this.remind(),
          reminders: this.remind()
            ? [{ offsetDays: 1, localTime: settings.defaultReminderTime, includeEventTitle: settings.notificationsRevealTitles }]
            : [],
        });
        if (milestone.ok) await this.milestones.create(milestone.value);
      }
      this.usage.markOnboardedThisSession();
      this.usage.track({
        name: 'onboarding_completed',
        props: {
          start_time: result.value.startTime !== null,
          name: result.value.displayName !== null,
          photo: blob !== null,
          anniversary: addAnniversary,
          reminder: addAnniversary && this.remind(),
        },
      });
      await this.router.navigateByUrl('/tabs/home', { replaceUrl: true });
    } catch {
      await this.notice.show(this.t.t('onboarding.saveFailed'), 'warning');
    } finally {
      this.saving.set(false);
    }
  }
}
