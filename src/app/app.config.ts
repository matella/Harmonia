import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';
import { RouteReuseStrategy } from '@angular/router';

import { routes } from './app.routes';
import { CapacitorNotificationPort, UnavailableNotificationPort } from './core/platform/capacitor-notification-port';
import { BootstrapService } from './core/services/bootstrap.service';
import { I18nService } from './core/services/i18n.service';
import { NOTIFICATION_PORT } from './core/services/tokens';
import { registerIcons } from './shared/icons';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideIonicAngular({ innerHTMLTemplatesEnabled: false }),
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideRouter(routes, withComponentInputBinding()),
    {
      provide: NOTIFICATION_PORT,
      useFactory: () => {
        if (!Capacitor.isNativePlatform()) return new UnavailableNotificationPort();
        const t = inject(I18nService).translator;
        return new CapacitorNotificationPort(t.t('notification.channelName'), t.t('notification.channelDescription'));
      },
    },
    provideAppInitializer(() => {
      registerIcons();
      return inject(BootstrapService).start();
    }),
  ],
};
