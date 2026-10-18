import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { NavController } from '@ionic/angular';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToggle, IonToolbar } from '@ionic/angular';

import { MILESTONE_CATEGORIES, type LeapDayPolicy, type MilestoneCategory, type Recurrence } from '../../core/domain/models';
import { validateMilestone, type MilestoneDraft } from '../../core/domain/validation';
import { MediaStorageService } from '../../core/platform/media-storage.service';
import { I18nService } from '../../core/services/i18n.service';
import { MilestoneService } from '../../core/services/milestone.service';
import { NoticeService } from '../../core/services/notice.service';
import type { PhotoChange } from '../../core/services/profile.service';
import { AppStore } from '../../core/state/app-store';
import { DateFieldComponent } from '../../shared/components/date-field.component';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { ReminderOffsetsComponent } from '../../shared/components/reminder-offsets.component';
import { CATEGORY_ICONS } from '../../shared/icons';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { PendingPhoto } from '../../shared/utilities/local-photo';
import { validationMessage } from '../../shared/utilities/validation-messages';

/** Create or edit a milestone, including its reminders. Route: /milestone/new or /milestone/:id/edit. */
@Component({
  selector: 'hm-milestone-editor',
  imports: [
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonButton,
    IonTitle,
    IonContent,
    IonIcon,
    IonToggle,
    DateFieldComponent,
    PhotoFrameComponent,
    ReminderOffsetsComponent,
    ...I18N_PIPES,
  ],
  templateUrl: './milestone-editor.page.html',
  styleUrl: './milestone-editor.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MilestoneEditorPage implements OnInit, OnDestroy {
  protected readonly t = inject(I18nService).translator;
  protected readonly store = inject(AppStore);
  private readonly service = inject(MilestoneService);
  private readonly media = inject(MediaStorageService);
  private readonly notice = inject(NoticeService);
  private readonly nav = inject(NavController);

  /** Route parameter; absent when creating. */
  readonly id = input<string>();

  protected readonly categories = MILESTONE_CATEGORIES;
  protected readonly categoryIcons = CATEGORY_ICONS;

  protected readonly title = signal('');
  protected readonly category = signal<MilestoneCategory>('custom');
  protected readonly eventDate = signal<string | null>(null);
  protected readonly hasTime = signal(false);
  protected readonly eventTime = signal<string | null>(null);
  protected readonly recurrence = signal<Recurrence>('none');
  protected readonly leapPolicy = signal<LeapDayPolicy | null>(null);
  protected readonly note = signal('');
  protected readonly isPinned = signal(false);
  protected readonly remindersOn = signal(false);
  protected readonly offsets = signal<number[]>([]);
  protected readonly reminderTime = signal<string | null>('09:00');
  protected readonly revealTitle = signal(false);

  protected readonly existingPhoto = signal<string | null>(null);
  protected readonly newPhoto = new PendingPhoto();
  protected readonly photoRemoved = signal(false);

  protected readonly attempted = signal(false);
  protected readonly saving = signal(false);
  private titleTouched = false;

  protected readonly isEdit = computed(() => !!this.id());
  protected readonly isLeapDay = computed(() => this.eventDate()?.slice(5) === '02-29');

  private readonly draft = computed<MilestoneDraft>(() => ({
    title: this.title(),
    category: this.category(),
    eventDate: this.eventDate() ?? '',
    eventTime: this.hasTime() ? this.eventTime() : null,
    recurrence: this.recurrence(),
    leapDayPolicy: this.recurrence() === 'yearly' && this.isLeapDay() ? this.leapPolicy() : null,
    note: this.note(),
    isPinned: this.isPinned(),
    remindersEnabled: this.remindersOn(),
    reminders: this.offsets().map((offsetDays) => ({
      offsetDays,
      localTime: this.reminderTime() ?? '09:00',
      includeEventTitle: this.revealTitle(),
    })),
  }));

  protected readonly result = computed(() => validateMilestone(this.draft()));
  protected readonly errors = computed<Record<'title' | 'eventDate' | 'eventTime' | 'note' | 'reminders', string | null>>(() => {
    const r = this.result();
    if (r.ok || !this.attempted()) return { title: null, eventDate: null, eventTime: null, note: null, reminders: null };
    return {
      title: validationMessage(this.t, r.errors.title, 'title'),
      eventDate: validationMessage(this.t, r.errors.eventDate, 'date'),
      eventTime: validationMessage(this.t, r.errors.eventTime),
      note: validationMessage(this.t, r.errors.note),
      reminders: validationMessage(this.t, r.errors.reminders, 'reminders'),
    };
  });

  protected readonly photoPath = computed(() => (this.photoRemoved() ? null : this.existingPhoto()));
  protected readonly hasPhoto = computed(() => !!this.newPhoto.url() || !!this.photoPath());

  ngOnInit(): void {
    const settings = this.store.settings();
    this.reminderTime.set(settings.defaultReminderTime);
    this.revealTitle.set(settings.notificationsRevealTitles);
    this.offsets.set([...settings.defaultReminderOffsets]);
    const id = this.id();
    if (!id) return;
    const m = this.store.milestoneById(id);
    if (!m) return;
    this.titleTouched = true;
    this.title.set(m.title);
    this.category.set(m.category);
    this.eventDate.set(m.eventDate);
    this.hasTime.set(!!m.eventTime);
    this.eventTime.set(m.eventTime);
    this.recurrence.set(m.recurrence);
    this.leapPolicy.set(m.leapDayPolicy);
    this.note.set(m.note ?? '');
    this.isPinned.set(m.isPinned);
    this.existingPhoto.set(m.photoPath);
    const rules = this.store.rulesByMilestone().get(id) ?? [];
    this.remindersOn.set(rules.length > 0);
    if (rules.length > 0) {
      this.offsets.set(rules.map((r) => r.offsetDays));
      this.reminderTime.set(rules[0].localTime);
      this.revealTitle.set(rules[0].includeEventTitle);
    }
  }

  ngOnDestroy(): void {
    this.newPhoto.clear();
  }

  protected onTitleInput(value: string): void {
    this.titleTouched = value.trim().length > 0;
    this.title.set(value);
  }

  /** Choosing a preset suggests its name as the title until the user types their own. */
  protected chooseCategory(category: MilestoneCategory): void {
    this.category.set(category);
    if (!this.titleTouched) this.title.set(category === 'custom' ? '' : this.t.t(`category.${category}`));
    if (category === 'anniversary' || category === 'wedding') this.recurrence.set('yearly');
  }

  protected async choosePhoto(): Promise<void> {
    const [image] = await this.media.pickImages(false);
    if (image) {
      this.newPhoto.set(image);
      this.photoRemoved.set(false);
    }
  }

  protected removePhoto(): void {
    this.newPhoto.clear();
    this.photoRemoved.set(true);
  }

  protected async save(): Promise<void> {
    this.attempted.set(true);
    const result = this.result();
    if (!result.ok) {
      await this.notice.show(this.t.t('validation.fixErrors'), 'warning');
      return;
    }
    if (this.saving()) return;
    this.saving.set(true);
    const blob = this.newPhoto.blob;
    const photo: PhotoChange = blob ? { kind: 'set', image: blob } : this.photoRemoved() ? { kind: 'remove' } : { kind: 'keep' };
    try {
      const id = this.id();
      const saved = id ? await this.service.update(id, result.value, photo) : await this.service.create(result.value, photo);
      if (saved.permission === 'denied') await this.notice.show(this.t.t('milestone.permissionDenied'), 'warning');
      else if (saved.permission === 'unavailable') await this.notice.show(this.t.t('milestone.permissionUnavailable'));
      else await this.notice.show(this.t.t('milestone.saved'));
      if (id) this.nav.back();
      else await this.nav.navigateForward(['/milestone', saved.milestone.id], { replaceUrl: true });
    } catch {
      await this.notice.show(this.t.t('milestone.saveFailed'), 'warning');
    } finally {
      this.saving.set(false);
    }
  }
}
