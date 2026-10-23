import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NavController } from '@ionic/angular';
import { IonContent, IonIcon, IonSpinner, IonToggle } from '@ionic/angular';

import { DataDeletionService } from '../../core/services/data-deletion.service';
import { DataExportService } from '../../core/services/data-export.service';
import { UsageService } from '../../core/services/usage.service';
import { I18nService } from '../../core/services/i18n.service';
import { NoticeService } from '../../core/services/notice.service';
import { SettingsService } from '../../core/services/settings.service';
import { AppStore } from '../../core/state/app-store';
import { I18N_PIPES } from '../../shared/pipes/i18n.pipes';
import { ConfirmService } from '../../shared/services/confirm.service';
import { SettingsHeaderComponent } from './settings-header.component';

@Component({
  selector: 'hm-privacy-data',
  imports: [IonContent, IonIcon, IonSpinner, IonToggle, SettingsHeaderComponent, ...I18N_PIPES],
  template: `
    <hm-settings-header [title]="'privacy.title' | t" />
    <ion-content>
      <div class="hm-page">
        <p class="statement">
          <ion-icon name="lock-closed-outline" aria-hidden="true" />
          <span>{{ (usage.available ? 'privacy.statementWithUsage' : 'privacy.statement') | t }}</span>
        </p>

        @if (usage.available) {
          <section class="hm-section" aria-labelledby="usage-heading">
            <h2 id="usage-heading" class="hm-section__title">{{ 'usage.title' | t }}</h2>
            <div class="hm-switch-row">
              <label class="hm-switch-row__text" for="p-usage">
                {{ 'usage.toggle' | t }}
                <span class="hm-switch-row__hint">{{ 'usage.toggleHint' | t: { destination: usage.destination } }}</span>
              </label>
              <ion-toggle id="p-usage" [checked]="usage.enabled()" (ionChange)="setUsage($event.detail.checked)" />
            </div>
          </section>
        }

        <section class="hm-section" aria-labelledby="export-heading">
          <h2 id="export-heading" class="hm-section__title">{{ 'privacy.export' | t }}</h2>
          <p class="hm-section__hint">{{ 'privacy.exportHint' | t }}</p>
          <button type="button" class="hm-btn hm-btn--outline action" [disabled]="busy()" (click)="export()">
            @if (exporting()) {
              <ion-spinner name="crescent" />{{ 'privacy.exporting' | t }}
            } @else {
              <ion-icon name="download-outline" aria-hidden="true" />{{ 'privacy.exportAction' | t }}
            }
          </button>
          <p class="hm-section__hint" role="status">{{ exportStatus() }}</p>
        </section>

        <section class="hm-section danger-zone" aria-labelledby="delete-heading">
          <h2 id="delete-heading" class="hm-section__title">{{ 'privacy.delete' | t }}</h2>
          <p class="hm-section__hint">{{ 'privacy.deleteHint' | t }}</p>
          <button type="button" class="hm-btn hm-btn--danger action" [disabled]="busy()" (click)="deleteAll()">
            <ion-icon name="trash-outline" aria-hidden="true" />{{ 'privacy.delete' | t }}
          </button>
        </section>
      </div>
    </ion-content>
  `,
  styles: `
    .statement {
      display: flex;
      gap: var(--hm-space-3);
      margin-top: var(--hm-space-4);
      padding: var(--hm-space-5);
      border-radius: var(--hm-radius-card);
      background: var(--hm-surface-muted);
      line-height: 1.6;

      ion-icon {
        flex: none;
        font-size: 22px;
        color: var(--hm-berry);
        margin-top: 2px;
      }
    }
    .action {
      margin: var(--hm-space-4) 0 var(--hm-space-2);
    }
    .danger-zone {
      padding-top: var(--hm-space-6);
      border-top: var(--hm-hairline);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrivacyDataPage {
  private readonly t = inject(I18nService).translator;
  private readonly exporter = inject(DataExportService);
  private readonly deletion = inject(DataDeletionService);
  private readonly confirm = inject(ConfirmService);
  private readonly notice = inject(NoticeService);
  private readonly nav = inject(NavController);
  protected readonly usage = inject(UsageService);
  private readonly settings = inject(SettingsService);
  private readonly store = inject(AppStore);

  protected readonly exporting = signal(false);
  protected readonly busy = signal(false);
  protected readonly exportStatus = signal('');

  protected async export(): Promise<void> {
    this.busy.set(true);
    this.exporting.set(true);
    this.exportStatus.set('');
    try {
      const result = await this.exporter.exportAndShare(this.t.t('privacy.exportShareTitle'));
      if (result.shared) this.usage.track({ name: 'export_created', props: { complete: result.document.mediaComplete } });
      if (!result.shared) this.exportStatus.set(this.t.t('privacy.exportCancelled'));
      else if (!result.document.mediaComplete) this.exportStatus.set(this.t.t('privacy.exportIncomplete'));
      else this.exportStatus.set(this.t.t('privacy.exportDone', { name: result.fileName }));
    } catch {
      this.exportStatus.set(this.t.t('privacy.exportFailed'));
    } finally {
      this.exporting.set(false);
      this.busy.set(false);
    }
  }

  protected async deleteAll(): Promise<void> {
    const confirmed = await this.confirm.confirmDestructive(
      this.t.t('privacy.deleteTitle'),
      this.t.t('privacy.deleteBody'),
      this.t.t('privacy.deleteConfirm'),
    );
    if (!confirmed) return;
    this.busy.set(true);
    try {
      const report = await this.deletion.deleteEverything();
      await this.nav.navigateRoot('/welcome', { animated: false });
      await this.notice.show(
        !report.sharingRemoved
          ? this.t.t('privacy.deleteSharingOffline')
          : report.remindersCancelled && report.widgetsCleared
            ? this.t.t('privacy.deleteDone')
            : this.t.t('privacy.deletePartial'),
      );
    } catch {
      await this.notice.show(this.t.t('privacy.deleteFailed'), 'warning');
    } finally {
      this.busy.set(false);
    }
  }

  /** Answers the one-time invitation too, so it never appears after a choice here. */
  protected async setUsage(enabled: boolean): Promise<void> {
    if (enabled === this.store.settings().usageSharing && this.store.settings().usagePromptAnswered) return;
    try {
      await this.settings.update({ usageSharing: enabled, usagePromptAnswered: true });
    } catch {
      await this.notice.show(this.t.t('settings.saveFailed'), 'warning');
    }
  }
}
