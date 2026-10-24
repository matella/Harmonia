import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular';

import { SharingService } from '../../core/services/sharing.service';
import { AppStore } from '../../core/state/app-store';
import { EmptyStateComponent } from '../../shared/components/empty-state.component';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';

/** Memories, newest first, as a two-column grid of photo and note cards. */
@Component({
  selector: 'hm-memories',
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonIcon,
    IonContent,
    EmptyStateComponent,
    PhotoFrameComponent,
    ...I18N_PIPES,
  ],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-title>{{ 'memories.title' | t }}</ion-title>
        <ion-buttons slot="end">
          <ion-button routerLink="/memory/new" [attr.aria-label]="'memories.add' | t">
            <ion-icon slot="icon-only" name="add" aria-hidden="true" />
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <div class="hm-page">
        @if (store.memories().length === 0) {
          <hm-empty-state
            icon="images-outline"
            [title]="'memories.emptyTitle' | t"
            [body]="(sharing.sharingOn() ? 'memories.emptyBodyShared' : 'memories.emptyBody') | t"
            [actionLabel]="'memories.add' | t"
            (action)="add()"
          />
        } @else {
          <ul class="grid">
            @for (memory of store.memories(); track memory.id) {
              <li>
                <a class="card" [routerLink]="['/memory', memory.id]">
                  @if (memory.media[0]; as cover) {
                    <hm-photo-frame shape="soft" ratio="4 / 5" [path]="cover.thumbnailPath ?? cover.filePath" [alt]="''" />
                    @if (memory.media.length > 1) {
                      <span class="count hm-num">{{ 'timeline.photos' | tp: memory.media.length }}</span>
                    }
                  } @else {
                    <span class="quote">{{ memory.body }}</span>
                  }
                  <span class="title">{{ memory.title || ('memory.untitled' | t) }}</span>
                  <span class="date">{{ memory.memoryDate | hmDate: 'medium' }}</span>
                </a>
              </li>
            }
          </ul>
        }
      </div>
    </ion-content>
  `,
  styles: `
    .grid {
      list-style: none;
      margin: var(--hm-space-2) 0 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: var(--hm-space-6) var(--hm-space-4);
    }
    .card {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 4px;
      color: inherit;
      text-decoration: none;
    }
    .quote {
      aspect-ratio: 4 / 5;
      padding: var(--hm-space-4);
      border-radius: var(--hm-radius-control);
      background: var(--hm-surface);
      border: var(--hm-hairline);
      font-family: var(--hm-font-display);
      font-style: italic;
      font-size: var(--hm-text-md);
      line-height: 1.5;
      color: var(--hm-ink);
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 7;
      -webkit-box-orient: vertical;
    }
    .count {
      position: absolute;
      top: 8px;
      right: 8px;
      padding: 2px 8px;
      border-radius: var(--hm-radius-pill);
      background: color-mix(in srgb, var(--hm-ink) 70%, transparent);
      color: var(--hm-canvas);
      font-size: var(--hm-text-xs);
    }
    .title {
      margin-top: var(--hm-space-1);
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .date {
      font-size: var(--hm-text-sm);
      color: var(--hm-ink-muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemoriesPage {
  protected readonly store = inject(AppStore);
  private readonly router = inject(Router);
  protected readonly sharing = inject(SharingService);

  ionViewWillEnter(): void {
    void this.sharing.ensureStatus();
  }

  protected add(): void {
    void this.router.navigateByUrl('/memory/new');
  }
}
