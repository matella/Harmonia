import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonToolbar } from '@ionic/angular';

import { I18nService } from '../../core/services/i18n.service';
import { MemoryService } from '../../core/services/memory.service';
import { NoticeService } from '../../core/services/notice.service';
import { AppStore } from '../../core/state/app-store';
import { EmptyStateComponent } from '../../shared/components/empty-state.component';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { ConfirmService } from '../../shared/services/confirm.service';

@Component({
  selector: 'hm-memory-detail',
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonButton,
    IonContent,
    IonIcon,
    EmptyStateComponent,
    PhotoFrameComponent,
    ...I18N_PIPES,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/memories" [text]="''" /></ion-buttons>
        @if (memory(); as m) {
          <ion-buttons slot="end">
            <ion-button [routerLink]="['/memory', m.id, 'edit']">{{ 'common.edit' | t }}</ion-button>
          </ion-buttons>
        }
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <div class="hm-page">
        @if (memory(); as m) {
          <p class="date">{{ m.memoryDate | hmDate: 'full' }}</p>
          <h1>{{ m.title || ('memory.untitled' | t) }}</h1>
          @if (linked(); as milestone) {
            <a class="linked" [routerLink]="['/milestone', milestone.id]">
              <ion-icon name="link-outline" aria-hidden="true" />{{ milestone.title }}
            </a>
          }
          @if (m.body) {
            <p class="body">{{ m.body }}</p>
          }
          @if (m.media.length > 0) {
            <ul class="gallery">
              @for (media of m.media; track media.id; let i = $index) {
                <li>
                  <hm-photo-frame
                    shape="soft"
                    ratio="auto"
                    [path]="media.filePath"
                    [alt]="'memory.photoAlt' | t: { index: i + 1, total: m.media.length }"
                  />
                </li>
              }
            </ul>
          }
          <div class="hm-actions">
            <button type="button" class="hm-btn hm-btn--danger" (click)="delete()">
              <ion-icon name="trash-outline" aria-hidden="true" />{{ 'common.delete' | t }}
            </button>
          </div>
        } @else {
          <hm-empty-state icon="images-outline" [title]="'memory.notFound' | t" />
        }
      </div>
    </ion-content>
  `,
  styles: `
    .date {
      margin-top: var(--hm-space-4);
      font-size: var(--hm-text-sm);
      color: var(--hm-ink-muted);
    }
    h1 {
      margin-top: var(--hm-space-2);
      font-size: var(--hm-text-3xl);
      line-height: 1.1;
      overflow-wrap: anywhere;
    }
    .linked {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: var(--hm-space-3);
      min-height: var(--hm-tap);
      color: var(--hm-berry);
      text-decoration: none;
      font-weight: 500;
    }
    .body {
      margin-top: var(--hm-space-4);
      font-family: var(--hm-font-display);
      font-size: var(--hm-text-lg);
      line-height: 1.65;
      white-space: pre-wrap;
      max-width: 60ch;
    }
    .gallery {
      list-style: none;
      margin: var(--hm-space-8) 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--hm-space-4);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemoryDetailPage {
  protected readonly store = inject(AppStore);
  private readonly t = inject(I18nService).translator;
  private readonly service = inject(MemoryService);
  private readonly confirm = inject(ConfirmService);
  private readonly notice = inject(NoticeService);
  private readonly router = inject(Router);

  readonly id = input.required<string>();

  protected readonly memory = computed(() => this.store.memoryById(this.id()));
  protected readonly linked = computed(() => {
    const id = this.memory()?.milestoneId;
    return id ? this.store.milestoneById(id) : null;
  });

  protected async delete(): Promise<void> {
    const confirmed = await this.confirm.confirmDestructive(
      this.t.t('memory.deleteTitle'),
      this.t.t('memory.deleteBody'),
      this.t.t('common.delete'),
    );
    if (!confirmed) return;
    try {
      await this.service.delete(this.id());
      await this.router.navigateByUrl('/tabs/memories', { replaceUrl: true });
      await this.notice.show(this.t.t('memory.deleted'));
    } catch {
      await this.notice.show(this.t.t('memory.saveFailed'), 'warning');
    }
  }
}
