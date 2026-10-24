import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { IonContent, IonIcon } from '@ionic/angular';

import type { TrashItem } from '../../core/domain/models';
import { trashDaysLeft } from '../../core/domain/trash';
import { I18nService } from '../../core/services/i18n.service';
import { NoticeService } from '../../core/services/notice.service';
import { SharingService } from '../../core/services/sharing.service';
import { CLOCK } from '../../core/services/tokens';
import { TrashService } from '../../core/services/trash.service';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { ConfirmService } from '../../shared/services/confirm.service';
import { SettingsHeaderComponent } from './settings-header.component';

/** "Recently deleted": dates and memories kept 30 days before they are purged. */
@Component({
  selector: 'hm-trash',
  imports: [IonContent, IonIcon, SettingsHeaderComponent, ...I18N_PIPES],
  template: `
    <hm-settings-header [title]="'trash.title' | t" />
    <ion-content>
      <div class="hm-page">
        <p class="hm-section__hint intro">{{ 'trash.intro' | t }}</p>
        @if (trash.items().length === 0) {
          <p class="empty">{{ 'trash.empty' | t }}</p>
        } @else {
          <ul class="items">
            @for (item of trash.items(); track item.kind + item.id) {
              @let name = titleOf(item);
              <li class="item hm-card">
                <div class="item__text">
                  <span class="item__kind">
                    <ion-icon [name]="item.kind === 'milestone' ? 'calendar-outline' : 'image-outline'" aria-hidden="true" />
                    {{ (item.kind === 'milestone' ? 'trash.kind.milestone' : 'trash.kind.memory') | t }}
                  </span>
                  <span class="item__title">{{ name }}</span>
                  <span class="item__meta">
                    {{ item.date | hmDate: 'medium' }}
                    @if (item.memoryCount > 0) {
                      · {{ 'trash.withMemories' | tp: item.memoryCount }}
                    }
                  </span>
                  <span class="item__meta">{{ expiry(item) }}</span>
                </div>
                <div class="item__actions">
                  <button
                    type="button"
                    class="hm-btn hm-btn--outline"
                    [disabled]="busy()"
                    [attr.aria-label]="'trash.restoreLabel' | t: { title: name }"
                    (click)="restore(item)"
                  >
                    {{ 'trash.restore' | t }}
                  </button>
                  <button
                    type="button"
                    class="hm-btn hm-btn--quiet danger"
                    [disabled]="busy()"
                    [attr.aria-label]="'trash.deleteForeverLabel' | t: { title: name }"
                    (click)="deleteForever(item)"
                  >
                    {{ 'trash.deleteForever' | t }}
                  </button>
                </div>
              </li>
            }
          </ul>
        }
      </div>
    </ion-content>
  `,
  styles: `
    .intro {
      margin-top: var(--hm-space-4);
    }
    .empty {
      margin-top: var(--hm-space-8);
      color: var(--hm-ink-muted);
      text-align: center;
    }
    .items {
      list-style: none;
      margin: var(--hm-space-5) 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--hm-space-3);
    }
    .item {
      padding: var(--hm-space-4);
      display: flex;
      flex-direction: column;
      gap: var(--hm-space-3);
    }
    .item__text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .item__kind {
      display: inline-flex;
      align-items: center;
      gap: var(--hm-space-1);
      font-size: var(--hm-text-sm);
      color: var(--hm-ink-muted);
    }
    .item__title {
      font-family: var(--hm-font-display);
      font-size: var(--hm-text-lg);
      overflow-wrap: anywhere;
    }
    .item__meta {
      font-size: var(--hm-text-sm);
      color: var(--hm-ink-muted);
    }
    .item__actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--hm-space-2);
    }
    .danger {
      color: var(--hm-danger);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashPage {
  protected readonly trash = inject(TrashService);
  private readonly t = inject(I18nService).translator;
  private readonly clock = inject(CLOCK);
  private readonly confirm = inject(ConfirmService);
  private readonly notice = inject(NoticeService);
  private readonly sharing = inject(SharingService);
  protected readonly busy = signal(false);

  ionViewWillEnter(): void {
    void this.trash.refresh().catch(() => undefined);
  }

  protected titleOf(item: TrashItem): string {
    return item.title ?? this.t.t('memory.untitled');
  }

  protected expiry(item: TrashItem): string {
    const days = trashDaysLeft(item.deletedAt, this.clock.now());
    return days === 0 ? this.t.t('trash.lastDay') : this.t.plural('trash.daysLeft', days);
  }

  protected async restore(item: TrashItem): Promise<void> {
    await this.run(() => this.trash.restore(item), 'trash.restored');
  }

  protected async deleteForever(item: TrashItem): Promise<void> {
    // While sharing, a purge removes it from every device and the server too (§18).
    await this.sharing.ensureStatus();
    const shared = this.sharing.sharingOn();
    const ok = await this.confirm.confirmDestructive(
      this.t.t('trash.deleteForeverTitle'),
      this.t.t(shared ? 'trash.deleteForeverBodyShared' : 'trash.deleteForeverBody'),
      this.t.t('trash.deleteForever'),
    );
    if (ok) await this.run(() => this.trash.deleteForever(item), 'trash.deletedForever');
  }

  private async run(action: () => Promise<void>, done: 'trash.restored' | 'trash.deletedForever'): Promise<void> {
    this.busy.set(true);
    try {
      await action();
      await this.notice.show(this.t.t(done));
    } catch {
      await this.notice.show(this.t.t('trash.failed'), 'warning');
    } finally {
      this.busy.set(false);
    }
  }
}
