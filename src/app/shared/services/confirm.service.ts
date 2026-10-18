import { Injectable, inject } from '@angular/core';
import { AlertController } from '@ionic/angular';

import { I18nService } from '../../core/services/i18n.service';

export interface ConfirmChoice<T extends string> {
  value: T;
  label: string;
  destructive?: boolean;
}

/**
 * Confirmation dialogs. Destructive choices are styled and announced as such; the
 * cancel action is always present and is the default for dismissal.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly alerts = inject(AlertController);
  private readonly t = inject(I18nService).translator;

  /** Resolves to the chosen value, or null if cancelled/dismissed. */
  async choose<T extends string>(header: string, message: string, choices: ConfirmChoice<T>[]): Promise<T | null> {
    const alert = await this.alerts.create({
      header,
      message,
      buttons: [
        { text: this.t.t('common.cancel'), role: 'cancel' },
        ...choices.map((choice) => ({
          text: choice.label,
          role: choice.destructive ? 'destructive' : undefined,
          cssClass: choice.destructive ? 'hm-alert-destructive' : undefined,
          handler: () => {
            alert.dismiss(choice.value, 'choice');
            return false;
          },
        })),
      ],
    });
    await alert.present();
    const { data, role } = await alert.onDidDismiss<T>();
    return role === 'choice' && data ? data : null;
  }

  async confirmDestructive(header: string, message: string, confirmLabel: string): Promise<boolean> {
    return (await this.choose(header, message, [{ value: 'yes', label: confirmLabel, destructive: true }])) === 'yes';
  }
}
