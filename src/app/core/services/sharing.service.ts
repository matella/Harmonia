import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

import { createSecureKeyStore } from '../platform/secure-key-store';
import { SYNC_CONFIG, type SyncServerConfig } from '../platform/sync-config';
import { DEV_SYNC_CONFIG } from '../platform/sync-dev-config';
import type {
  CurrentInvite,
  InviteProgress,
  JoinProgress,
  MyDevice,
  Sharing,
  SharingStatus,
} from '../sync/sharing';
import type { SyncReport } from '../sync/sync-engine';
import { SerialQueue } from '../persistence/sql-driver';
import { AppStore } from '../state/app-store';
import { DatabaseService } from './database.service';
import { I18nService } from './i18n.service';
import { NoticeService } from './notice.service';
import { SyncService } from './sync.service';
import { CLOCK } from './tokens';

/**
 * The sharing server. Null means sharing does not exist in the app. Release builds use
 * `SYNC_CONFIG`. Development builds fall back to the local stack: on a device through
 * `adb reverse`, in the browser preview only when served from this machine.
 */
export const SYNC_SERVER = new InjectionToken<SyncServerConfig | null>('SYNC_SERVER', {
  providedIn: 'root',
  factory: () => {
    // Development builds on a device reach the local stack through `adb reverse`
    // (docs/PARTNER_SYNC.md §17); in release builds DEV_SYNC_CONFIG is null.
    if (Capacitor.isNativePlatform()) return SYNC_CONFIG ?? DEV_SYNC_CONFIG;
    const host = globalThis.location?.hostname;
    const local = host === 'localhost' || host === '127.0.0.1' || host?.endsWith('.localhost');
    return local ? DEV_SYNC_CONFIG : null;
  },
});

export type SharingView = SharingStatus | 'unknown';

/** How long after a local edit its upload starts, so quick successive edits share one sync. */
const AFTER_CHANGE_DELAY_MS = 2000;

/**
 * Angular side of partner sharing (docs/PARTNER_SYNC.md §6, §17). The crypto library
 * and the Supabase client load only when sharing is used, so solo users never download
 * them. After anything that changed local data, state is reloaded and reminders and
 * widgets are refreshed (persist first, then side effects).
 */
@Injectable({ providedIn: 'root' })
export class SharingService {
  private readonly server = inject(SYNC_SERVER);
  private readonly db = inject(DatabaseService);
  private readonly sync = inject(SyncService);
  private readonly clock = inject(CLOCK);
  private readonly store = inject(AppStore);
  private readonly notice = inject(NoticeService);
  private readonly t = inject(I18nService).translator;
  private loading: Promise<Sharing> | null = null;
  /** Syncs run one after another, never side by side. */
  private readonly queue = new SerialQueue();
  private autoTimer: ReturnType<typeof setTimeout> | null = null;

  readonly available = this.server !== null;
  readonly status = signal<SharingView>('unknown');

  constructor() {
    // Local edits are uploaded shortly after they are saved; quick successive edits
    // share one sync.
    this.sync.onLocalChange(() => this.requestSync(AFTER_CHANGE_DELAY_MS));
  }

  /**
   * Syncs in the background soon (on start, on resume, after a local change). A solo
   * device stops after one local database check: nothing is loaded and nothing is sent.
   * Failures stay silent (offline, a join still waiting, keys unavailable); the next
   * trigger tries again.
   */
  requestSync(delayMs = 0): void {
    if (!this.available) return;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      void this.autoSync();
    }, delayMs);
  }

  private async autoSync(): Promise<void> {
    try {
      if (!(await this.db.repos.sync.state())) return;
      await this.syncNow();
    } catch {
      // Retried on the next start, resume or change.
    }
  }

  async refresh(): Promise<SharingView> {
    if (!this.available) return 'off';
    const status = await (await this.sharing()).status();
    this.status.set(status);
    return status;
  }

  startSharing(selfName: string): Promise<void> {
    return this.queue.run(async () => {
      try {
        await (await this.sharing()).startSharing(selfName);
      } finally {
        await this.afterChange();
      }
    });
  }

  /** `forMe`: an invite for one of my own devices (§7.6). */
  async createInvite(forMe = false): Promise<string> {
    return (await this.sharing()).createInvite({ forMe });
  }

  async currentInvite(): Promise<CurrentInvite | null> {
    return (await this.sharing()).currentInvite();
  }

  async checkInvite(): Promise<InviteProgress> {
    return (await this.sharing()).checkInvite();
  }

  async approveInvite(): Promise<void> {
    await (await this.sharing()).approveInvite();
  }

  async declineInvite(): Promise<void> {
    await (await this.sharing()).declineInvite();
  }

  async claim(code: string, selfName: string): Promise<string> {
    try {
      return await (await this.sharing()).claim(code, selfName);
    } finally {
      await this.afterChange();
    }
  }

  checkJoin(): Promise<JoinProgress> {
    return this.queue.run(async () => {
      const progress = await (await this.sharing()).checkJoin();
      if (progress.state !== 'waiting') await this.afterChange();
      return progress;
    });
  }

  chooseStart(choice: 'space' | 'mine'): Promise<JoinProgress> {
    return this.queue.run(async () => {
      try {
        return await (await this.sharing()).chooseStart(choice);
      } finally {
        await this.afterChange();
      }
    });
  }

  async cancelJoin(): Promise<void> {
    await (await this.sharing()).cancelJoin();
    await this.refresh();
  }

  /** 'ended' when the server said sharing is over; this device has then gone solo. */
  syncNow(): Promise<SyncReport | 'ended'> {
    return this.queue.run(async () => {
      const partner = this.store.profile()?.displayName ?? null;
      let report: SyncReport;
      try {
        report = await (await this.sharing()).sync();
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'sharingEnded') throw error;
        await this.afterChange();
        const removed = (error as { reason?: unknown }).reason === 'removed';
        void this.notice.show(
          removed
            ? this.t.t('sharing.removedHere')
            : partner
              ? this.t.t('sharing.ended', { name: partner })
              : this.t.t('sharing.endedNoName'),
        );
        return 'ended';
      }
      if (report.changedTypes.length > 0)
        await this.sync.afterChange({ quiet: true, remote: true });
      await this.refresh();
      return report;
    });
  }

  /** Leaves the space for both people; this device keeps everything. */
  /** My devices in the space; only these can be removed from the screen (§7.7). */
  async myDevices(): Promise<MyDevice[]> {
    return (await this.sharing()).myDevices();
  }

  /** Removes one of my other devices and changes the space key (§7.4). */
  removeDevice(deviceId: string): Promise<void> {
    return this.queue.run(async () => {
      await (await this.sharing()).removeDevice(deviceId);
      await this.afterChange();
    });
  }

  leave(): Promise<void> {
    return this.queue.run(async () => {
      await (await this.sharing()).leave();
      await this.afterChange();
    });
  }

  /** Back to solo on this device; every record stays. */
  stopSharingHere(): Promise<void> {
    return this.queue.run(async () => {
      await (await this.sharing()).stopSharingHere();
      await this.afterChange();
    });
  }

  /** State changed by the sharing flow itself (it has already synced what it needed to). */
  private async afterChange(): Promise<void> {
    await this.sync.afterChange({ quiet: true, remote: true });
    await this.refresh();
  }

  private sharing(): Promise<Sharing> {
    const server = this.server;
    if (!server) return Promise.reject(new Error('Sharing is not available'));
    this.loading ??= (async () => {
      const [{ loadSyncCrypto }, { Sharing }, { DeviceSession }, { createClient }] =
        await Promise.all([
          import('../sync/sync-crypto-port'),
          import('../sync/sharing'),
          import('../sync/device-session'),
          import('@supabase/supabase-js'),
        ]);
      const crypto = await loadSyncCrypto();
      const secrets = createSecureKeyStore();
      const platform = Capacitor.getPlatform() === 'ios' ? 'ios' : 'android';
      const session = new DeviceSession(secrets, crypto, platform, (storage) =>
        createClient(server.url, server.publishableKey, {
          auth: {
            storage,
            storageKey: 'session',
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
          },
        }),
      );
      return new Sharing({
        store: this.db.repos.sync,
        profiles: this.db.repos.profile,
        session,
        crypto,
        secrets,
        defaults: () => ({ calendarTimeZoneId: this.clock.timeZoneId() }),
      });
    })();
    this.loading.catch(() => {
      this.loading = null;
    });
    return this.loading;
  }
}
