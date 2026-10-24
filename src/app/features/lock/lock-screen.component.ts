import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  type AfterViewInit,
  type ElementRef,
  viewChild,
} from '@angular/core';
import { IonIcon } from '@ionic/angular';

import { AppLockService } from '../../core/services/app-lock.service';
import { I18nService } from '../../core/services/i18n.service';
import { EmblemComponent } from '../../shared/components/emblem.component';

/**
 * Covers the whole app while it is locked (docs/APP_LOCK.md). Opens the phone's own
 * unlock right away, once; after a cancel, the button opens it again.
 */
@Component({
  selector: 'hm-lock-screen',
  imports: [IonIcon, EmblemComponent],
  template: `
    <div class="lock" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <hm-emblem [size]="52" />
      <h1 id="lock-title">{{ t.t('lock.title') }}</h1>
      <p class="hm-muted">{{ t.t('lock.body') }}</p>
      <button #unlockButton type="button" class="hm-btn" [disabled]="busy()" (click)="unlock()">
        <ion-icon name="lock-open-outline" aria-hidden="true" />{{ t.t('lock.unlock') }}
      </button>
      @if (failed()) {
        <p class="hm-field__error" role="alert">{{ t.t('lock.failed') }}</p>
      }
    </div>
  `,
  styles: `
    .lock {
      position: fixed;
      inset: 0;
      z-index: 100000;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--hm-space-4);
      padding: var(--hm-space-6);
      padding-top: calc(var(--ion-safe-area-top, 0px) + var(--hm-space-6));
      background: var(--hm-surface);
      text-align: center;
    }
    h1 {
      font-size: var(--hm-text-2xl);
      margin: 0;
    }
    p {
      margin: 0;
      max-width: 32ch;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LockScreenComponent implements AfterViewInit {
  protected readonly t = inject(I18nService).translator;
  private readonly lock = inject(AppLockService);
  private readonly button = viewChild<ElementRef<HTMLButtonElement>>('unlockButton');
  protected readonly busy = signal(false);
  protected readonly failed = signal(false);

  ngAfterViewInit(): void {
    this.button()?.nativeElement.focus();
    void this.unlock();
  }

  protected async unlock(): Promise<void> {
    this.busy.set(true);
    this.failed.set(false);
    try {
      this.failed.set((await this.lock.unlock()) === 'failed');
    } finally {
      this.busy.set(false);
    }
  }
}
