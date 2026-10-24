import { InjectionToken } from '@angular/core';

import { systemClock, type Clock } from '../domain/clock';
import { createAppLockPort, type AppLockPort } from '../platform/app-lock';
import type { NotificationPort } from '../platform/notification-port';
import { createQrScanner, type QrScannerPort } from '../platform/qr-scanner';

export const CLOCK = new InjectionToken<Clock>('CLOCK', { providedIn: 'root', factory: () => systemClock });

export const NOTIFICATION_PORT = new InjectionToken<NotificationPort>('NOTIFICATION_PORT');

/** The phone's own unlock (docs/APP_LOCK.md); nothing to offer in the browser preview. */
/** Scanning an invite's QR code; not offered in the browser preview. */
export const QR_SCANNER = new InjectionToken<QrScannerPort>('QR_SCANNER', {
  providedIn: 'root',
  factory: createQrScanner,
});

export const APP_LOCK_PORT = new InjectionToken<AppLockPort>('APP_LOCK_PORT', {
  providedIn: 'root',
  factory: createAppLockPort,
});

/** App version shown in About and written into exports (kept in sync with package.json). */
export const APP_VERSION = '1.0.0';
