import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs } from '@ionic/angular';

import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';

@Component({
  selector: 'hm-tabs',
  imports: [IonTabs, IonTabBar, IonTabButton, IonIcon, IonLabel, ...I18N_PIPES],
  template: `
    <ion-tabs>
      <ion-tab-bar slot="bottom">
        <ion-tab-button tab="home">
          <ion-icon name="home-outline" aria-hidden="true" />
          <ion-label>{{ 'tabs.home' | t }}</ion-label>
        </ion-tab-button>
        <ion-tab-button tab="timeline">
          <ion-icon name="git-commit-outline" class="rotate" aria-hidden="true" />
          <ion-label>{{ 'tabs.timeline' | t }}</ion-label>
        </ion-tab-button>
        <ion-tab-button tab="dates">
          <ion-icon name="calendar-clear-outline" aria-hidden="true" />
          <ion-label>{{ 'tabs.dates' | t }}</ion-label>
        </ion-tab-button>
        <ion-tab-button tab="memories">
          <ion-icon name="images-outline" aria-hidden="true" />
          <ion-label>{{ 'tabs.memories' | t }}</ion-label>
        </ion-tab-button>
      </ion-tab-bar>
    </ion-tabs>
  `,
  styles: `
    .rotate {
      transform: rotate(90deg);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TabsPage {}
