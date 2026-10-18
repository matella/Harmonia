import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IonContent } from '@ionic/angular';

import { APP_VERSION } from '../../core/services/tokens';
import { EmblemComponent } from '../../shared/components/emblem.component';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { SettingsHeaderComponent } from './settings-header.component';

@Component({
  selector: 'hm-about',
  imports: [IonContent, EmblemComponent, SettingsHeaderComponent, ...I18N_PIPES],
  template: `
    <hm-settings-header [title]="'about.title' | t" />
    <ion-content>
      <div class="hm-page">
        <div class="brand">
          <hm-emblem [size]="48" />
          <h1>{{ 'app.name' | t }}</h1>
          <p class="tagline">{{ 'app.tagline' | t }}</p>
          <p class="hm-muted">{{ 'about.version' | t: { version: version } }}</p>
        </div>
        <p class="body">{{ 'about.body' | t }}</p>
        <section class="hm-section">
          <h2 class="hm-section__title">{{ 'about.licenses' | t }}</h2>
          <p class="hm-section__hint">{{ 'about.fonts' | t }}</p>
          <p class="hm-section__hint">{{ 'about.libraries' | t }}</p>
        </section>
      </div>
    </ion-content>
  `,
  styles: `
    .brand {
      display: flex;
      flex-direction: column;
      gap: var(--hm-space-2);
      margin-top: var(--hm-space-8);
    }
    h1 {
      font-size: var(--hm-text-3xl);
      color: var(--hm-berry);
      font-weight: 400;
    }
    .tagline {
      font-family: var(--hm-font-display);
      font-style: italic;
      font-size: var(--hm-text-lg);
    }
    .body {
      margin-top: var(--hm-space-6);
      max-width: 52ch;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AboutPage {
  protected readonly version = APP_VERSION;
}
