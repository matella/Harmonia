import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSpinner,
  IonTitle,
  IonToolbar,
  NavController,
} from '@ionic/angular';

import type { MemoryMedia } from '../../core/domain/models';
import { validateMemory } from '../../core/domain/validation';
import { MAX_PHOTOS_PER_PICK, MediaStorageService } from '../../core/platform/media-storage.service';
import { I18nService } from '../../core/services/i18n.service';
import { MemoryService } from '../../core/services/memory.service';
import { NoticeService } from '../../core/services/notice.service';
import { AppStore } from '../../core/state/app-store';
import { DateFieldComponent } from '../../shared/components/date-field.component';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { validationMessage } from '../../shared/utilities/validation-messages';

interface NewImage {
  key: string;
  blob: Blob;
  url: string;
}

const MAX_PHOTOS = 30;

@Component({
  selector: 'hm-memory-editor',
  imports: [
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonButton,
    IonTitle,
    IonContent,
    IonIcon,
    IonSpinner,
    DateFieldComponent,
    PhotoFrameComponent,
    ...I18N_PIPES,
  ],
  templateUrl: './memory-editor.page.html',
  styleUrl: './memory-editor.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemoryEditorPage implements OnInit, OnDestroy {
  protected readonly t = inject(I18nService).translator;
  protected readonly store = inject(AppStore);
  private readonly service = inject(MemoryService);
  private readonly media = inject(MediaStorageService);
  private readonly notice = inject(NoticeService);
  private readonly nav = inject(NavController);
  private readonly route = inject(ActivatedRoute);

  readonly id = input<string>();

  protected readonly title = signal('');
  protected readonly body = signal('');
  protected readonly memoryDate = signal<string | null>(null);
  protected readonly milestoneId = signal<string | null>(null);
  protected readonly existing = signal<MemoryMedia[]>([]);
  protected readonly removedIds = signal<string[]>([]);
  protected readonly added = signal<NewImage[]>([]);
  protected readonly attempted = signal(false);
  protected readonly saving = signal(false);
  protected readonly picking = signal(false);
  private keySeq = 0;

  protected readonly isEdit = computed(() => !!this.id());
  protected readonly keptMedia = computed(() => this.existing().filter((m) => !this.removedIds().includes(m.id)));
  protected readonly photoCount = computed(() => this.keptMedia().length + this.added().length);
  protected readonly milestones = computed(() =>
    [...this.store.milestones()].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })),
  );

  protected readonly result = computed(() =>
    validateMemory({
      title: this.title(),
      body: this.body(),
      memoryDate: this.memoryDate() ?? '',
      milestoneId: this.milestoneId(),
      photoCount: this.photoCount(),
    }),
  );
  protected readonly errors = computed<Record<'title' | 'body' | 'memoryDate', string | null>>(() => {
    const r = this.result();
    if (r.ok || !this.attempted()) return { title: null, body: null, memoryDate: null };
    return {
      title: validationMessage(this.t, r.errors.title),
      body: validationMessage(this.t, r.errors.body),
      memoryDate: validationMessage(this.t, r.errors.memoryDate, 'date'),
    };
  });

  ngOnInit(): void {
    const id = this.id();
    if (id) {
      const memory = this.store.memoryById(id);
      if (!memory) return;
      this.title.set(memory.title ?? '');
      this.body.set(memory.body ?? '');
      this.memoryDate.set(memory.memoryDate);
      this.milestoneId.set(memory.milestoneId);
      this.existing.set(memory.media);
      return;
    }
    this.memoryDate.set(this.store.today().toString());
    const linked = this.route.snapshot.queryParamMap.get('milestone');
    if (linked && this.store.milestoneById(linked)) this.milestoneId.set(linked);
  }

  ngOnDestroy(): void {
    for (const image of this.added()) URL.revokeObjectURL(image.url);
  }

  protected async addPhotos(): Promise<void> {
    if (this.picking()) return;
    this.picking.set(true);
    try {
      const images = await this.media.pickImages(true);
      const room = MAX_PHOTOS - this.photoCount();
      const next = images.slice(0, Math.min(room, MAX_PHOTOS_PER_PICK)).map((blob) => ({
        key: `new-${++this.keySeq}`,
        blob,
        url: URL.createObjectURL(blob),
      }));
      this.added.set([...this.added(), ...next]);
    } catch {
      await this.notice.show(this.t.t('memory.photoFailed'), 'warning');
    } finally {
      this.picking.set(false);
    }
  }

  protected removeExisting(id: string): void {
    this.removedIds.set([...this.removedIds(), id]);
  }

  protected removeAdded(key: string): void {
    const image = this.added().find((i) => i.key === key);
    if (image) URL.revokeObjectURL(image.url);
    this.added.set(this.added().filter((i) => i.key !== key));
  }

  protected onLinkChange(value: string): void {
    this.milestoneId.set(value || null);
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
    try {
      const blobs = this.added().map((i) => i.blob);
      const id = this.id();
      const memory = id
        ? await this.service.update(id, result.value, blobs, this.removedIds())
        : await this.service.create(result.value, blobs);
      await this.notice.show(this.t.t('memory.saved'));
      if (id) this.nav.back();
      else await this.nav.navigateForward(['/memory', memory.id], { replaceUrl: true });
    } catch {
      await this.notice.show(this.t.t('memory.saveFailed'), 'warning');
    } finally {
      this.saving.set(false);
    }
  }
}
