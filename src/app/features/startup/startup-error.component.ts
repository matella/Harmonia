import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { IonContent } from '@ionic/angular';

import { I18nService } from '../../core/services/i18n.service';
import { AppStore } from '../../core/state/app-store';
import { EmblemComponent } from '../../shared/components/emblem.component';

/**
 * Shown when the database cannot be opened or migrated. Data is never wiped
 * automatically; the user can retry (reload) and share the diagnostic detail.
 */
@Component({
  selector: 'hm-startup-error',
  imports: [IonContent, EmblemComponent],
  template: `
    <ion-content>
      <div class="hm-page wrap">
        <hm-emblem [size]="44" />
        <h1>{{ t.t('startup.title') }}</h1>
        <p class="hm-muted">{{ message() }}</p>
        <p class="detail">{{ t.t('startup.details', { detail: store.failure()?.detail ?? '' }) }}</p>
        <button type="button" class="hm-btn" (click)="retry()">{{ t.t('startup.retry') }}</button>
      </div>
    </ion-content>
  `,
  styles: `
    .wrap {
      display: flex;
      flex-direction: column;
      gap: var(--hm-space-4);
      padding-top: calc(var(--ion-safe-area-top, 0px) + var(--hm-space-12));
    }
    h1 {
      font-size: var(--hm-text-2xl);
    }
    .detail {
      font-size: var(--hm-text-xs);
      color: var(--hm-ink-muted);
      overflow-wrap: anywhere;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StartupErrorComponent {
  protected readonly t = inject(I18nService).translator;
  protected readonly store = inject(AppStore);

  protected readonly message = computed(() => {
    switch (this.store.failure()?.kind) {
      case 'migration':
        return this.t.t('startup.migration');
      case 'too-new':
        return this.t.t('startup.tooNew');
      default:
        return this.t.t('startup.unknown');
    }
  });

  protected retry(): void {
    location.reload();
  }
}
