import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { IonApp, IonRouterOutlet } from '@ionic/angular';

import { AppLockService } from './core/services/app-lock.service';
import { AppStore } from './core/state/app-store';
import { LockScreenComponent } from './features/lock/lock-screen.component';
import { StartupErrorComponent } from './features/startup/startup-error.component';

@Component({
  selector: 'hm-root',
  imports: [IonApp, IonRouterOutlet, LockScreenComponent, StartupErrorComponent],
  template: `
    <ion-app>
      @if (store.status() === 'error') {
        <hm-startup-error />
      } @else {
        <ion-router-outlet
          [attr.inert]="lock.locked() ? '' : null"
          [attr.aria-hidden]="lock.locked() ? 'true' : null"
        />
        @if (lock.locked()) {
          <hm-lock-screen />
        } @else if (lock.covered()) {
          <div class="cover" aria-hidden="true"></div>
        }
      }
    </ion-app>
  `,
  styles: `
    .cover {
      position: fixed;
      inset: 0;
      z-index: 100000;
      background: var(--hm-surface);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(AppStore);
  protected readonly lock = inject(AppLockService);
}
