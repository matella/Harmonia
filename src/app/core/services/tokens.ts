import { InjectionToken } from '@angular/core';

import { systemClock, type Clock } from '../domain/clock';
import type { NotificationPort } from '../platform/notification-port';

export const CLOCK = new InjectionToken<Clock>('CLOCK', { providedIn: 'root', factory: () => systemClock });

export const NOTIFICATION_PORT = new InjectionToken<NotificationPort>('NOTIFICATION_PORT');

/** App version shown in About and written into exports (kept in sync with package.json). */
export const APP_VERSION = '1.0.0';
