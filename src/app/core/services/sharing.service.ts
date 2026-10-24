import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

import { createSecureKeyStore } from '../platform/secure-key-store';
import { SYNC_CONFIG, type SyncServerConfig } from '../platform/sync-config';
import { allSharingSecretNames, spaceKeyName } from '../sync/secret-names';
import { DEV_SYNC_CONFIG } from '../platform/sync-dev-config';
import type {
  CurrentInvite,
  InviteProgress,
  JoinProgress,
  MyDevice,
  NewRecoveryKey,
  RecoveryStatus,
  Sharing,
  SharingStatus,
  SharingSyncReport,
} from '../sync/sharing';
import { fromBase64 } from '../sync/encoding';
import type { PhotoFiles } from '../sync/photo-sync';
import { MediaStorageService } from '../platform/media-storage.service';
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
  private readonly media = inject(MediaStorageService);
  private readonly t = inject(I18nService).translator;
  private loading: Promise<Sharing> | null = null;
  /** One store for every sharing secret (in the browser preview it lives in memory only). */
  private readonly secrets = createSecureKeyStore();
  /** Syncs run one after another, never side by side. */
  private readonly queue = new SerialQueue();
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private photosFullShown = false;
  private spaceFullShown = false;

  readonly available = this.server !== null;
  readonly status = signal<SharingView>('unknown');
  /** In a shared space, as far as the last status check knows (see `ensureStatus`). */
  readonly sharingOn = computed(() => {
    const status = this.status();
    return status === 'member' || status === 'memberWithoutKey' || status === 'joining';
  });

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
      const report = await this.syncNow();
      // Said once when the space becomes full (§9): new photos then stay on this phone.
      const full = report !== 'ended' && report.photos?.storageFull === true;
      if (full && !this.photosFullShown) void this.notice.show(this.t.t('sharing.photosFull'));
      this.photosFullShown = full;
      this.spaceFullShown = false;
    } catch (error) {
      // Retried on the next start, resume or change. A full space is said once (§19).
      if ((error as { code?: unknown } | null)?.code === 'spaceFull' && !this.spaceFullShown) {
        this.spaceFullShown = true;
        void this.notice.show(this.t.t('sharing.error.spaceFull'));
      }
    }
  }

  /**
   * The status, checked if it isn't known yet. Never throws. A solo device stops after the
   * local database check, like `autoSync`: the sharing code (libsodium, Supabase) isn't loaded.
   */
  async ensureStatus(): Promise<SharingView> {
    if (this.status() !== 'unknown' || !this.available) return this.status();
    try {
      if (!(await this.db.repos.sync.state())) return 'off';
      return await this.refresh();
    } catch {
      return this.status();
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
  syncNow(): Promise<SharingSyncReport | 'ended'> {
    return this.queue.run(async () => {
      const partner = this.store.profile()?.displayName ?? null;
      let report: SharingSyncReport;
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

  /**
   * Before "Delete all data": takes this device out of the shared space (§17). Returns
   * false if sharing is on but the server couldn't be reached; the wipe goes ahead anyway.
   * A solo device is not touched and nothing is loaded.
   */
  async removeThisDevice(): Promise<boolean> {
    if (!this.available) return true;
    if (!(await this.db.repos.sync.state())) return true;
    try {
      await this.queue.run(async () => (await this.sharing()).removeThisDevice());
      return true;
    } catch {
      return false;
    }
  }

  /** Forgets every sharing secret on this device (device keys, session, space keys). */
  async forgetSecrets(): Promise<void> {
    const state = await this.db.repos.sync.state().catch(() => null);
    const names = allSharingSecretNames();
    if (state) {
      for (let epoch = 1; epoch <= state.epoch; epoch++)
        names.push(spaceKeyName(state.spaceId, epoch));
    }
    for (const name of names) await this.secrets.remove(name).catch(() => undefined);
    this.loading = null;
  }

  async hasPartner(): Promise<boolean> {
    return (await this.sharing()).hasPartner();
  }

  /** Bytes of shared photos in the space, and its limit. */
  async photoStorage(): Promise<{ used: number; limit: number }> {
    return (await this.sharing()).photoStorage();
  }

  /** Whether my person has a recovery key in this space (§8). */
  async recoveryStatus(): Promise<RecoveryStatus> {
    return (await this.sharing()).recoveryStatus();
  }

  /** A new recovery key, in memory only until it is confirmed. */
  async createRecoveryKey(): Promise<NewRecoveryKey> {
    return (await this.sharing()).createRecoveryKey();
  }

  /** False when the server couldn't be reached: the key takes effect on a later sync. */
  confirmRecoveryKey(answers: readonly [string, string]): Promise<boolean> {
    return this.queue.run(async () => {
      try {
        return await (await this.sharing()).confirmRecoveryKey(answers);
      } finally {
        await this.afterChange();
      }
    });
  }

  async discardRecoveryKey(): Promise<void> {
    (await this.sharing()).discardRecoveryKey();
  }

  /** Joins the space as the person holding this recovery key (§8). */
  recover(text: string): Promise<void> {
    return this.queue.run(async () => {
      try {
        await (await this.sharing()).recover(text);
      } finally {
        await this.afterChange();
      }
    });
  }

  /** Leaves the space for both people; this device keeps everything. */
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
      const secrets = this.secrets;
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
      const media = this.media;
      const photoFiles: PhotoFiles = {
        read: async (path) => {
          const data = await media.readBase64(path);
          return data ? fromBase64(data) : null;
        },
        saveDownloaded: (bytes) => media.storeDownloaded(bytes),
      };
      return new Sharing({
        store: this.db.repos.sync,
        profiles: this.db.repos.profile,
        session,
        crypto,
        secrets,
        defaults: () => ({ calendarTimeZoneId: this.clock.timeZoneId() }),
        photoFiles,
      });
    })();
    this.loading.catch(() => {
      this.loading = null;
    });
    return this.loading;
  }
}
