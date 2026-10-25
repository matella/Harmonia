import { Injectable, computed, effect, inject } from '@angular/core';

import { AppStore } from '../state/app-store';
import { DatabaseService } from './database.service';
import { I18nService } from './i18n.service';
import { NoticeService } from './notice.service';
import { SharingService } from './sharing.service';
import { SyncService } from './sync.service';

/**
 * "Thinking of you" (docs/PARTNER_SYNC.md §22): a tap that tells the partner, through the
 * shared space, that you thought of them. It carries only the time it was sent. It
 * arrives when the partner's app next syncs (on opening it, and while it is open); there
 * is no push notification, so nothing new is asked of Google or Apple.
 */
@Injectable({ providedIn: 'root' })
export class NudgeService {
  private readonly store = inject(AppStore);
  private readonly db = inject(DatabaseService);
  private readonly sync = inject(SyncService);
  private readonly sharing = inject(SharingService);
  private readonly notice = inject(NoticeService);
  private readonly t = inject(I18nService).translator;

  /** Offered only in a shared space this device can read. */
  readonly available = computed(() => this.sharing.status() === 'member');

  private announced: string | null = null;

  constructor() {
    // A nudge that arrives (or is waiting at start) is said once, wherever the user is.
    effect(() => {
      const nudge = this.store.nudge();
      if (!nudge.unseen || !nudge.received || nudge.received === this.announced) return;
      this.announced = nudge.received;
      const name = this.store.profile()?.displayName;
      void this.notice.show(
        name ? this.t.t('nudge.received', { name }) : this.t.t('nudge.receivedNoName'),
      );
    });
  }

  async send(): Promise<'sent' | 'tooSoon' | 'failed'> {
    try {
      const result = await this.db.repos.sync.sendNudge();
      if (result === 'noSelf') return 'failed';
      if (result === 'sent') await this.sync.afterChange({ quiet: true }); // reloads and uploads
      return result;
    } catch {
      return 'failed';
    }
  }

  /** The user has seen the latest one; this device stops showing it. */
  async markSeen(): Promise<void> {
    await this.db.repos.sync.markNudgeSeen();
    await this.sync.reload();
  }
}
