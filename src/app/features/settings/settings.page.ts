import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular';

import { SharingService } from '../../core/services/sharing.service';
import { AppStore } from '../../core/state/app-store';
import { PhotoFrameComponent } from '../../shared/components/photo-frame.component';
import { I18N_PIPES, type MessageKey } from '../../shared/pipes/i18n.pipes';

interface SettingsLink {
  route: string;
  icon: string;
  title: MessageKey;
  hint: MessageKey;
}

const SHARING_LINK: SettingsLink = {
  route: '/settings/sharing',
  icon: 'people-outline',
  title: 'settings.sharing',
  hint: 'settings.sharingHint',
};

const LINKS: SettingsLink[] = [
  { route: '/settings/appearance', icon: 'color-palette-outline', title: 'settings.appearance', hint: 'settings.appearanceHint' },
  { route: '/settings/reminders', icon: 'notifications-outline', title: 'settings.reminders', hint: 'settings.remindersHint' },
  { route: '/settings/widgets', icon: 'grid-outline', title: 'settings.widgets', hint: 'settings.widgetsHint' },
  { route: '/settings/trash', icon: 'trash-outline', title: 'settings.trash', hint: 'settings.trashHint' },
  { route: '/settings/privacy', icon: 'shield-checkmark-outline', title: 'settings.privacy', hint: 'settings.privacyHint' },
  { route: '/settings/about', icon: 'information-circle-outline', title: 'settings.about', hint: 'about.body' },
];

@Component({
  selector: 'hm-settings',
  imports: [RouterLink, IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, IonIcon, PhotoFrameComponent, ...I18N_PIPES],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/home" [text]="''" /></ion-buttons>
        <ion-title>{{ 'settings.title' | t }}</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <div class="hm-page">
        @if (store.profile(); as p) {
          <a class="profile hm-card" routerLink="/settings/profile">
            <hm-photo-frame class="avatar" shape="round" [path]="p.photoPath" [emblemSize]="24" [alt]="''" />
            <span class="profile__text">
              <span class="profile__title">{{ p.displayName || ('settings.profile' | t) }}</span>
              <span class="profile__hint">{{ 'counter.togetherSince' | t: { date: (p.startDate | hmDate: 'long') } }}</span>
            </span>
            <ion-icon class="hm-row__chevron" name="chevron-forward" aria-hidden="true" />
          </a>
        }
        <ul class="hm-rows links">
          @for (link of links; track link.route) {
            <li>
              <a class="hm-row" [routerLink]="link.route">
                <span class="hm-row__icon" aria-hidden="true"><ion-icon [name]="link.icon" /></span>
                <span class="hm-row__body">
                  <span class="hm-row__title">{{ link.title | t }}</span>
                  <span class="hm-row__meta">{{ link.hint | t }}</span>
                </span>
                <ion-icon class="hm-row__chevron" name="chevron-forward" aria-hidden="true" />
              </a>
            </li>
          }
        </ul>
      </div>
    </ion-content>
  `,
  styles: `
    .profile {
      display: flex;
      align-items: center;
      gap: var(--hm-space-4);
      margin-top: var(--hm-space-2);
      color: inherit;
      text-decoration: none;
    }
    .avatar {
      width: 56px;
      flex: none;
    }
    .profile__text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .profile__title {
      font-family: var(--hm-font-display);
      font-size: var(--hm-text-lg);
    }
    .profile__hint {
      font-size: var(--hm-text-sm);
      color: var(--hm-ink-muted);
    }
    .links {
      margin-top: var(--hm-space-6);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  protected readonly store = inject(AppStore);
  /** "Share with your partner" exists only when a sharing server is configured. */
  protected readonly links: SettingsLink[] = inject(SharingService).available ? [SHARING_LINK, ...LINKS] : LINKS;
}
