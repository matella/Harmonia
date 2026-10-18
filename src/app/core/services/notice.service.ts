import { Injectable, inject } from '@angular/core';
import { ToastController } from '@ionic/angular';

import { I18nService } from './i18n.service';

/** Short, non-blocking status messages (announced politely to screen readers). */
@Injectable({ providedIn: 'root' })
export class NoticeService {
  private readonly toasts = inject(ToastController);
  private readonly t = inject(I18nService).translator;

  async show(message: string, tone: 'info' | 'warning' = 'info'): Promise<void> {
    const toast = await this.toasts.create({
      message,
      duration: tone === 'warning' ? 6000 : 2500,
      position: 'bottom',
      cssClass: tone === 'warning' ? 'hm-toast hm-toast--warning' : 'hm-toast',
      buttons: tone === 'warning' ? [{ text: this.t.t('common.ok'), role: 'cancel' }] : undefined,
    });
    await toast.present();
  }
}
