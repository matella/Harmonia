import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

import { createSecureKeyStore } from '../platform/secure-key-store';
import { SYNC_CONFIG, type SyncServerConfig } from '../platform/sync-config';
import { DEV_SYNC_CONFIG } from '../platform/sync-dev-config';
import type { InviteProgress, JoinProgress, Sharing, SharingStatus } from '../sync/sharing';
import type { SyncReport } from '../sync/sync-engine';
import { DatabaseService } from './database.service';
import { SyncService } from './sync.service';
import { CLOCK } from './tokens';

/**
 * The sharing server. Null means sharing does not exist in the app. Native builds use
 * `SYNC_CONFIG`; the browser preview uses the local development stack, and only in
 * development builds served from this machine.
 */
export const SYNC_SERVER = new InjectionToken<SyncServerConfig | null>('SYNC_SERVER', {
  providedIn: 'root',
  factory: () => {
    if (Capacitor.isNativePlatform()) return SYNC_CONFIG;
    const host = globalThis.location?.hostname;
    const local = host === 'localhost' || host === '127.0.0.1' || host?.endsWith('.localhost');
    return local ? DEV_SYNC_CONFIG : null;
  },
});

export type SharingView = SharingStatus | 'unknown';

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
  private loading: Promise<Sharing> | null = null;

  readonly available = this.server !== null;
  readonly status = signal<SharingView>('unknown');

  async refresh(): Promise<SharingView> {
    if (!this.available) return 'off';
    const status = await (await this.sharing()).status();
    this.status.set(status);
    return status;
  }

  async startSharing(selfName: string): Promise<void> {
    try {
      await (await this.sharing()).startSharing(selfName);
    } finally {
      await this.afterChange();
    }
  }

  async createInvite(): Promise<string> {
    return (await this.sharing()).createInvite();
  }

  async currentInviteCode(): Promise<string | null> {
    return (await this.sharing()).currentInviteCode();
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

  async checkJoin(): Promise<JoinProgress> {
    const progress = await (await this.sharing()).checkJoin();
    if (progress.state !== 'waiting') await this.afterChange();
    return progress;
  }

  async chooseStart(choice: 'space' | 'mine'): Promise<JoinProgress> {
    try {
      return await (await this.sharing()).chooseStart(choice);
    } finally {
      await this.afterChange();
    }
  }

  async cancelJoin(): Promise<void> {
    await (await this.sharing()).cancelJoin();
    await this.refresh();
  }

  async syncNow(): Promise<SyncReport> {
    const report = await (await this.sharing()).sync();
    if (report.changedTypes.length > 0) await this.sync.afterChange({ quiet: true });
    await this.refresh();
    return report;
  }

  /** Back to solo on this device; every record stays. */
  async stopSharingHere(): Promise<void> {
    await (await this.sharing()).stopSharingHere();
    await this.afterChange();
  }

  private async afterChange(): Promise<void> {
    await this.sync.afterChange({ quiet: true });
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
