import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular';

import { buildYearRecap, recapHasContent, recapYears } from '../../core/domain/year-recap';
import { MediaStorageService } from '../../core/platform/media-storage.service';
import { I18nService } from '../../core/services/i18n.service';
import { NoticeService } from '../../core/services/notice.service';
import { AppStore } from '../../core/state/app-store';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { renderRecapImage } from './recap-image';

/**
 * "Your year together": the year in numbers and photos, and a picture of it to share.
 * Everything is computed from what is on the phone; the picture holds no names or dates.
 */
@Component({
  selector: 'hm-recap',
  imports: [IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, IonIcon, PhotoFrameComponent, ...I18N_PIPES],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/settings" [text]="''" /></ion-buttons>
        <ion-title role="heading" aria-level="1">{{ 'recap.title' | t }}</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <div class="hm-page recap">
        @if (recap(); as r) {
          <div class="years" role="group" [attr.aria-label]="'recap.title' | t">
            <button type="button" class="hm-btn hm-btn--quiet" [disabled]="!hasPrevious()" [attr.aria-label]="'recap.previousYear' | t" (click)="move(1)">
              <ion-icon name="chevron-back" aria-hidden="true" />
            </button>
            <h2 class="years__year">{{ r.year }}</h2>
            <button type="button" class="hm-btn hm-btn--quiet" [disabled]="!hasNext()" [attr.aria-label]="'recap.nextYear' | t" (click)="move(-1)">
              <ion-icon name="chevron-forward" aria-hidden="true" />
            </button>
          </div>

          <p class="big hm-card">
            <span class="big__number hm-num">{{ r.daysTogether }}</span>
            <span class="big__label">{{ 'recap.daysLabel' | tp: r.daysTogether }}</span>
          </p>

          <ul class="stats">
            <li class="hm-card"><span class="stats__value hm-num">{{ r.dates }}</span>{{ 'recap.dates' | tp: r.dates }}</li>
            <li class="hm-card"><span class="stats__value hm-num">{{ r.memories }}</span>{{ 'recap.memories' | tp: r.memories }}</li>
            <li class="hm-card"><span class="stats__value hm-num">{{ r.photos }}</span>{{ 'recap.photos' | tp: r.photos }}</li>
          </ul>

          @if (r.highlights.length > 0) {
            <ul class="highlights">
              @for (h of r.highlights; track h.memoryId) {
                <li><hm-photo-frame shape="soft" ratio="1 / 1" [path]="h.path" [alt]="''" /></li>
              }
            </ul>
          }

          @if (!hasContent()) {
            <p class="hm-section__hint">{{ 'recap.empty' | t }}</p>
          }
          <button type="button" class="hm-btn hm-btn--block" [disabled]="busy()" (click)="share()">
            <ion-icon name="share-outline" aria-hidden="true" />{{ (busy() ? 'recap.sharing' : 'recap.share') | t }}
          </button>
          <p class="hm-section__hint note">{{ 'recap.privacyNote' | t }}</p>
        }
      </div>
    </ion-content>
  `,
  styles: `
    .recap {
      display: flex;
      flex-direction: column;
      gap: var(--hm-space-4);
    }
    .years {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .years__year {
      margin: 0;
      font-family: var(--hm-font-display);
      font-size: var(--hm-text-2xl);
    }
    .big {
      margin: 0;
      display: flex;
      flex-direction: column;
    }
    .big__number {
      font-family: var(--hm-font-display);
      font-size: 4.5rem;
      line-height: 1;
      color: var(--hm-berry);
    }
    .big__label {
      color: var(--hm-ink-muted);
    }
    .stats {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--hm-space-3);
    }
    .stats li {
      padding: var(--hm-space-3);
      display: flex;
      flex-direction: column;
      color: var(--hm-ink-muted);
      font-size: var(--hm-text-sm);
    }
    .stats__value {
      font-family: var(--hm-font-display);
      font-size: var(--hm-text-2xl);
      color: var(--hm-ink);
    }
    .highlights {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--hm-space-3);
    }
    .note {
      margin: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecapPage {
  private readonly store = inject(AppStore);
  private readonly media = inject(MediaStorageService);
  private readonly notice = inject(NoticeService);
  private readonly t = inject(I18nService).translator;

  protected readonly busy = signal(false);
  /** The year shown; null means the newest one that has something to show. */
  private readonly chosen = signal<number | null>(null);

  private readonly years = computed(() => {
    const profile = this.store.profile();
    return profile ? recapYears(profile.startDate, this.store.today()) : [];
  });
  private readonly year = computed(() => this.chosen() ?? this.years()[0] ?? null);

  protected readonly recap = computed(() => {
    const profile = this.store.profile();
    const year = this.year();
    if (!profile || year === null) return null;
    return buildYearRecap(profile.startDate, this.store.milestones(), this.store.memories(), year, this.store.today(), this.store.settings().leapDayPolicy);
  });
  protected readonly hasContent = computed(() => {
    const r = this.recap();
    return !!r && recapHasContent(r);
  });
  protected readonly hasPrevious = computed(() => this.years().indexOf(this.year() ?? 0) < this.years().length - 1);
  protected readonly hasNext = computed(() => this.years().indexOf(this.year() ?? 0) > 0);

  /** +1 goes to the year before, -1 to the year after. */
  protected move(step: 1 | -1): void {
    const years = this.years();
    const next = years[years.indexOf(this.year() ?? 0) + step];
    if (next !== undefined) this.chosen.set(next);
  }

  /** The picture of the shown year, for the share sheet. */
  protected async makePicture(): Promise<Blob> {
    const r = this.recap();
    if (!r) throw new Error('Nothing to draw');
    const urls = (await Promise.all(r.highlights.map((h) => this.media.displayUrl(h.path)))).filter((u): u is string => !!u);
    return renderRecapImage(
      {
        brand: this.t.t('app.name'),
        year: String(r.year),
        heading: this.t.t('recap.imageHeading'),
        dayCount: String(r.daysTogether),
        dayLabel: this.t.plural('recap.daysLabel', r.daysTogether),
        stats: [
          { value: String(r.dates), label: this.t.plural('recap.dates', r.dates) },
          { value: String(r.memories), label: this.t.plural('recap.memories', r.memories) },
          { value: String(r.photos), label: this.t.plural('recap.photos', r.photos) },
        ],
      },
      urls,
    );
  }

  protected async share(): Promise<void> {
    const r = this.recap();
    if (!r || this.busy()) return;
    this.busy.set(true);
    try {
      const blob = await this.makePicture();
      const fileName = `harmonia-${r.year}.png`;
      if (!Capacitor.isNativePlatform()) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
      // The previous picture, not this one, is cleared: the receiving app may still read it.
      await Filesystem.rmdir({ path: 'recaps', directory: Directory.Cache, recursive: true }).catch(() => undefined);
      const written = await Filesystem.writeFile({
        path: `recaps/${fileName}`,
        data: await toBase64(blob),
        directory: Directory.Cache,
        recursive: true,
      });
      await Share.share({ title: this.t.t('recap.imageHeading'), files: [written.uri], dialogTitle: this.t.t('recap.imageHeading') });
    } catch (error) {
      if (!/cancel/i.test(error instanceof Error ? error.message : String(error))) {
        await this.notice.show(this.t.t('recap.failed'), 'warning');
      }
    } finally {
      this.busy.set(false);
    }
  }
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
