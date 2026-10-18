import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { IonApp, IonRouterOutlet } from '@ionic/angular';

import { AppStore } from './core/state/app-store';
import { StartupErrorComponent } from './features/startup/startup-error.component';

@Component({
  selector: 'hm-root',
  imports: [IonApp, IonRouterOutlet, StartupErrorComponent],
  template: `
    <ion-app>
      @if (store.status() === 'error') {
        <hm-startup-error />
      } @else {
        <ion-router-outlet />
      }
    </ion-app>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(AppStore);
}
