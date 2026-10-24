import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IonBackButton, IonButtons, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';

/** Toolbar shared by settings sub-pages. */
@Component({
  selector: 'hm-settings-header',
  imports: [IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle],
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/settings" [text]="''" /></ion-buttons>
        <ion-title role="heading" aria-level="1">{{ title() }}</ion-title>
        <ng-content />
      </ion-toolbar>
    </ion-header>
  `,
  // Lets <ion-header> participate in the Ionic page layout as if it were a direct child.
  styles: `
    :host {
      display: contents;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsHeaderComponent {
  readonly title = input.required<string>();
}
