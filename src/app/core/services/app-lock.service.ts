import { Injectable, inject, signal } from '@angular/core';

import { shouldLockOnResume, type AppLockDelay } from '../domain/app-lock';
import type { UnlockResult } from '../platform/app-lock';
import { AppStore } from '../state/app-store';
import { I18nService } from './i18n.service';
import { SettingsService } from './settings.service';
import { APP_LOCK_PORT, CLOCK } from './tokens';

/**
 * App lock (docs/APP_LOCK.md): when it's on, Harmonia starts locked and locks again after
 * the chosen time in the background; the phone's own unlock opens it. The lock screen
 * covers everything; widgets and the watch keep showing what their own privacy setting
 * allows.
 */
@Injectable({ providedIn: 'root' })
export class AppLockService {
  private readonly port = inject(APP_LOCK_PORT);
  private readonly store = inject(AppStore);
  private readonly clock = inject(CLOCK);
  private readonly settings = inject(SettingsService);
  private readonly t = inject(I18nService).translator;

  readonly locked = signal(false);
  /**
   * Set as soon as the app leaves the foreground with the lock on: a plain cover, so the
   * recent-apps thumbnail and the first frame on return don't show anything. On return it
   * becomes the lock screen, or goes away if the lock isn't due yet.
   */
  readonly covered = signal(false);
  private backgroundSince: number | null = null;
  /** The system prompt (or the PIN screen) can send the app to the background itself. */
  private unlocking = false;

  /** At startup, once settings are loaded and before anything is shown. */
  init(): void {
    if (this.store.settings().appLock) this.lock();
  }

  onPause(): void {
    if (this.unlocking || this.locked()) return;
    this.backgroundSince = this.clock.now().epochMilliseconds;
    if (this.store.settings().appLock) this.covered.set(true);
  }

  onResume(): void {
    const settings = this.store.settings();
    if (
      !this.unlocking &&
      shouldLockOnResume(
        settings.appLock,
        settings.appLockAfter,
        this.backgroundSince,
        this.clock.now().epochMilliseconds,
      )
    ) {
      this.lock();
    }
    this.covered.set(false);
    this.backgroundSince = null;
  }

  /** Locks, closing any open dialog first: it would sit above the lock screen's reach. */
  private lock(): void {
    for (const overlay of document.querySelectorAll<
      HTMLElement & { dismiss?: () => Promise<boolean> }
    >('ion-alert, ion-modal, ion-action-sheet, ion-popover, ion-picker, ion-loading, ion-toast')) {
      void overlay.dismiss?.();
    }
    this.locked.set(true);
  }

  deviceIsSecure(): Promise<boolean> {
    return this.port.deviceIsSecure();
  }

  async unlock(): Promise<UnlockResult> {
    if (this.unlocking) return 'cancelled';
    this.unlocking = true;
    try {
      const result = await this.port.unlock(this.texts());
      if (result === 'unlocked') this.locked.set(false);
      return result;
    } finally {
      this.unlocking = false;
    }
  }

  /** Turning the lock on asks to unlock once, so nobody locks themselves out by mistake. */
  async enable(): Promise<UnlockResult> {
    if (!(await this.port.deviceIsSecure())) return 'failed';
    this.unlocking = true;
    try {
      const result = await this.port.unlock(this.texts());
      if (result === 'unlocked') await this.settings.update({ appLock: true });
      return result;
    } finally {
      this.unlocking = false;
    }
  }

  async disable(): Promise<void> {
    await this.settings.update({ appLock: false });
    this.locked.set(false);
  }

  async setDelay(minutes: AppLockDelay): Promise<void> {
    await this.settings.update({ appLockAfter: minutes });
  }

  private texts() {
    return {
      title: this.t.t('lock.prompt'),
      reason: this.t.t('lock.promptReason'),
      cancel: this.t.t('common.cancel'),
    };
  }
}
