import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { Share } from '@capacitor/share';
import { IonContent, IonIcon, IonSpinner } from '@ionic/angular';

import type { StartOfRelationship } from '../../core/sync/sync-store';
import type { InviteProgress, JoinProgress } from '../../core/sync/sharing';
import { I18nService } from '../../core/services/i18n.service';
import { NoticeService } from '../../core/services/notice.service';
import { SharingService } from '../../core/services/sharing.service';
import { AppStore } from '../../core/state/app-store';
import { I18N_PIPES, type MessageKey } from '../../shared/pipes/i18n.pipes';
import { ConfirmService } from '../../shared/services/confirm.service';
import { SettingsHeaderComponent } from './settings-header.component';

type View =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'start' }
  | { kind: 'join' }
  | { kind: 'invite'; code: string; progress: InviteProgress }
  | { kind: 'joining'; progress: JoinProgress }
  | { kind: 'member' }
  | { kind: 'noKey' };

/** How often an open screen asks the server about an invite or a join. */
const POLL_MS = 3000;

/**
 * Settings › Share with your partner (docs/PARTNER_SYNC.md §6.1–6.2). The invite is a
 * text code (QR comes later). The server is asked about the invite or the join only
 * while this screen is open.
 */
@Component({
  selector: 'hm-sharing',
  imports: [IonContent, IonIcon, IonSpinner, SettingsHeaderComponent, ...I18N_PIPES],
  template: `
    <hm-settings-header [title]="'sharing.title' | t" />
    <ion-content>
      <div class="hm-page">
        @switch (view().kind) {
          @case ('loading') {
            <div class="center"><ion-spinner name="crescent" /></div>
          }

          @case ('off') {
            <p class="statement">
              <ion-icon name="lock-closed-outline" aria-hidden="true" />
              <span>{{ 'sharing.intro' | t }}</span>
            </p>
            <p class="hm-section__hint">{{ 'sharing.whatShared' | t }}</p>
            <div class="actions">
              <button type="button" class="hm-btn" (click)="show({ kind: 'start' })">
                <ion-icon name="people-outline" aria-hidden="true" />{{ 'sharing.invite' | t }}
              </button>
              <button type="button" class="hm-btn hm-btn--outline" (click)="show({ kind: 'join' })">
                <ion-icon name="key-outline" aria-hidden="true" />{{ 'sharing.join' | t }}
              </button>
            </div>
          }

          @case ('start') {
            <form class="hm-form" (submit)="start(); $event.preventDefault()" novalidate>
              <p class="hm-section__hint">{{ 'sharing.whatShared' | t }}</p>
              <div class="hm-field">
                <label class="hm-field__label" for="s-name">{{ 'sharing.yourName' | t }}</label>
                <input
                  id="s-name"
                  class="hm-input"
                  type="text"
                  maxlength="60"
                  autocapitalize="words"
                  aria-describedby="s-name-hint"
                  [value]="selfName()"
                  (input)="selfName.set($any($event.target).value)"
                />
                <span id="s-name-hint" class="hm-field__hint">{{
                  'sharing.yourNameHint' | t
                }}</span>
              </div>
              @if (error()) {
                <p class="hm-field__error" role="alert">{{ error() }}</p>
              }
              <div class="actions">
                <button type="submit" class="hm-btn" [disabled]="busy()">
                  @if (busy()) {
                    <ion-spinner name="crescent" />{{ 'sharing.starting' | t }}
                  } @else {
                    {{ 'sharing.start' | t }}
                  }
                </button>
                <button
                  type="button"
                  class="hm-btn hm-btn--quiet"
                  [disabled]="busy()"
                  (click)="show({ kind: 'off' })"
                >
                  {{ 'common.cancel' | t }}
                </button>
              </div>
            </form>
          }

          @case ('join') {
            <form class="hm-form" (submit)="join(); $event.preventDefault()" novalidate>
              <h2 class="hm-section__title">{{ 'sharing.joinTitle' | t }}</h2>
              <p class="hm-section__hint">{{ 'sharing.whatShared' | t }}</p>
              <div class="hm-field">
                <label class="hm-field__label" for="j-code">{{ 'sharing.codeField' | t }}</label>
                <textarea
                  id="j-code"
                  class="hm-input code-input"
                  rows="3"
                  autocapitalize="off"
                  autocomplete="off"
                  spellcheck="false"
                  aria-describedby="j-code-hint"
                  [value]="codeText()"
                  (input)="codeText.set($any($event.target).value)"
                ></textarea>
                <span id="j-code-hint" class="hm-field__hint">{{
                  'sharing.codeFieldHint' | t
                }}</span>
              </div>
              <div class="hm-field">
                <label class="hm-field__label" for="j-name">{{ 'sharing.yourName' | t }}</label>
                <input
                  id="j-name"
                  class="hm-input"
                  type="text"
                  maxlength="60"
                  autocapitalize="words"
                  aria-describedby="j-name-hint"
                  [value]="selfName()"
                  (input)="selfName.set($any($event.target).value)"
                />
                <span id="j-name-hint" class="hm-field__hint">{{
                  'sharing.yourNameHint' | t
                }}</span>
              </div>
              @if (error()) {
                <p class="hm-field__error" role="alert">{{ error() }}</p>
              }
              <div class="actions">
                <button type="submit" class="hm-btn" [disabled]="busy()">
                  @if (busy()) {
                    <ion-spinner name="crescent" />{{ 'sharing.joining' | t }}
                  } @else {
                    {{ 'sharing.joinAction' | t }}
                  }
                </button>
                <button
                  type="button"
                  class="hm-btn hm-btn--quiet"
                  [disabled]="busy()"
                  (click)="show({ kind: 'off' })"
                >
                  {{ 'common.cancel' | t }}
                </button>
              </div>
            </form>
          }

          @case ('invite') {
            @let invite = inviteView();
            @if (invite) {
              @switch (invite.progress.state) {
                @case ('claimed') {
                  <section class="hm-section" aria-labelledby="claim-heading">
                    <h2 id="claim-heading" class="hm-section__title">
                      {{ 'sharing.claimedTitle' | t }}
                    </h2>
                    <p class="hm-section__hint">{{ 'sharing.claimedBody' | t }}</p>
                    <p
                      class="safety"
                      [attr.aria-label]="
                        ('sharing.safetyCode' | t) + ' ' + spaced(safetyOf(invite.progress))
                      "
                    >
                      <span class="safety__label" aria-hidden="true">{{
                        'sharing.safetyCode' | t
                      }}</span>
                      <span class="safety__digits" aria-hidden="true">{{
                        spaced(safetyOf(invite.progress))
                      }}</span>
                    </p>
                    <div class="actions">
                      <button type="button" class="hm-btn" [disabled]="busy()" (click)="approve()">
                        {{ 'sharing.approve' | t }}
                      </button>
                      <button
                        type="button"
                        class="hm-btn hm-btn--quiet danger"
                        [disabled]="busy()"
                        (click)="decline()"
                      >
                        {{ 'sharing.decline' | t }}
                      </button>
                    </div>
                  </section>
                }
                @default {
                  <section class="hm-section" aria-labelledby="code-heading">
                    <h2 id="code-heading" class="hm-section__title">
                      {{ 'sharing.codeTitle' | t }}
                    </h2>
                    <p class="hm-section__hint">{{ 'sharing.codeHint' | t }}</p>
                    <p class="code hm-card" translate="no">{{ invite.code }}</p>
                    <div class="actions">
                      <button
                        type="button"
                        class="hm-btn hm-btn--outline"
                        (click)="copy(invite.code)"
                      >
                        <ion-icon name="copy-outline" aria-hidden="true" />{{ 'sharing.copy' | t }}
                      </button>
                      <button
                        type="button"
                        class="hm-btn hm-btn--outline"
                        (click)="share(invite.code)"
                      >
                        <ion-icon name="share-outline" aria-hidden="true" />{{
                          'sharing.shareCode' | t
                        }}
                      </button>
                    </div>
                    <p class="waiting" role="status">
                      <ion-spinner name="dots" aria-hidden="true" />{{
                        'sharing.waitingForPartner' | t
                      }}
                    </p>
                  </section>
                }
              }
            }
          }

          @case ('joining') {
            @let joining = joiningView();
            @if (joining) {
              @switch (joining.progress.state) {
                @case ('chooseStart') {
                  @let choice = startChoice(joining.progress);
                  <section class="hm-section" aria-labelledby="start-heading">
                    <h2 id="start-heading" class="hm-section__title">
                      {{ 'sharing.chooseStartTitle' | t }}
                    </h2>
                    <p class="hm-section__hint">{{ 'sharing.chooseStartBody' | t }}</p>
                    <div class="actions actions--stacked">
                      <button
                        type="button"
                        class="hm-btn hm-btn--outline"
                        [disabled]="busy()"
                        (click)="chooseStart('space')"
                      >
                        {{
                          'sharing.startTheirs'
                            | t: { date: (choice.space.startDate | hmDate: 'long') }
                        }}
                      </button>
                      <button
                        type="button"
                        class="hm-btn hm-btn--outline"
                        [disabled]="busy()"
                        (click)="chooseStart('mine')"
                      >
                        {{
                          'sharing.startMine'
                            | t: { date: (choice.mine.startDate | hmDate: 'long') }
                        }}
                      </button>
                    </div>
                  </section>
                }
                @default {
                  <section class="hm-section" aria-labelledby="wait-heading">
                    <h2 id="wait-heading" class="hm-section__title">
                      {{ 'sharing.joinTitle' | t }}
                    </h2>
                    <p class="hm-section__hint">{{ 'sharing.waitingForApproval' | t }}</p>
                    @if (joinSafety(); as code) {
                      <p
                        class="safety"
                        [attr.aria-label]="('sharing.safetyCode' | t) + ' ' + spaced(code)"
                      >
                        <span class="safety__label" aria-hidden="true">{{
                          'sharing.safetyCode' | t
                        }}</span>
                        <span class="safety__digits" aria-hidden="true">{{ spaced(code) }}</span>
                      </p>
                    }
                    <p class="waiting" role="status">
                      <ion-spinner name="dots" aria-hidden="true" />
                    </p>
                    <div class="actions">
                      <button
                        type="button"
                        class="hm-btn hm-btn--quiet"
                        [disabled]="busy()"
                        (click)="cancelJoin()"
                      >
                        {{ 'sharing.cancelJoin' | t }}
                      </button>
                    </div>
                  </section>
                }
              }
            }
          }

          @case ('member') {
            <section class="hm-section" aria-labelledby="member-heading">
              <h2 id="member-heading" class="hm-section__title">
                @if (partnerName(); as name) {
                  {{ 'sharing.memberTitle' | t: { name } }}
                } @else {
                  {{ 'sharing.memberTitleNoName' | t }}
                }
              </h2>
              <p class="hm-section__hint">{{ 'sharing.memberBody' | t }}</p>
              <div class="actions">
                <button type="button" class="hm-btn" [disabled]="busy()" (click)="syncNow()">
                  @if (busy()) {
                    <ion-spinner name="crescent" />{{ 'sharing.syncing' | t }}
                  } @else {
                    <ion-icon name="sync-outline" aria-hidden="true" />{{ 'sharing.syncNow' | t }}
                  }
                </button>
              </div>
              <p class="hm-section__hint" role="status">{{ syncStatus() }}</p>
            </section>
          }

          @case ('noKey') {
            <section class="hm-section" aria-labelledby="nokey-heading">
              <h2 id="nokey-heading" class="hm-section__title">{{ 'sharing.noKeyTitle' | t }}</h2>
              <p class="hm-section__hint">{{ 'sharing.noKeyBody' | t }}</p>
              <div class="actions">
                <button
                  type="button"
                  class="hm-btn hm-btn--outline"
                  [disabled]="busy()"
                  (click)="stopHere()"
                >
                  {{ 'sharing.stopHere' | t }}
                </button>
              </div>
            </section>
          }
        }
        @if (error() && view().kind !== 'start' && view().kind !== 'join') {
          <p class="hm-field__error" role="alert">{{ error() }}</p>
        }
      </div>
    </ion-content>
  `,
  styles: `
    .center {
      display: flex;
      justify-content: center;
      margin-top: var(--hm-space-8);
    }
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
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--hm-space-2);
      margin: var(--hm-space-4) 0 var(--hm-space-2);
    }
    .actions--stacked {
      flex-direction: column;
      align-items: stretch;
    }
    .code {
      margin: var(--hm-space-4) 0 0;
      padding: var(--hm-space-4);
      font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      font-size: var(--hm-text-sm);
      overflow-wrap: anywhere;
      user-select: all;
    }
    .code-input {
      font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      resize: vertical;
    }
    .safety {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--hm-space-1);
      margin: var(--hm-space-5) 0;
      padding: var(--hm-space-5);
      border-radius: var(--hm-radius-card);
      background: var(--hm-surface-muted);
    }
    .safety__label {
      font-size: var(--hm-text-sm);
      color: var(--hm-ink-muted);
    }
    .safety__digits {
      font-family: var(--hm-font-display);
      font-size: 2.25rem;
      letter-spacing: 0.08em;
      font-variant-numeric: tabular-nums;
    }
    .waiting {
      display: flex;
      align-items: center;
      gap: var(--hm-space-2);
      color: var(--hm-ink-muted);
    }
    .danger {
      color: var(--hm-danger);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SharingPage implements OnInit, OnDestroy {
  private readonly sharing = inject(SharingService);
  private readonly store = inject(AppStore);
  private readonly t = inject(I18nService).translator;
  private readonly notice = inject(NoticeService);
  private readonly confirm = inject(ConfirmService);

  protected readonly view = signal<View>({ kind: 'loading' });
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly syncStatus = signal('');
  protected readonly selfName = signal('');
  protected readonly codeText = signal('');
  protected readonly joinSafety = signal<string | null>(null);
  protected readonly partnerName = computed(() => this.store.profile()?.displayName ?? null);
  protected readonly inviteView = computed(() => {
    const v = this.view();
    return v.kind === 'invite' ? v : null;
  });
  protected readonly joiningView = computed(() => {
    const v = this.view();
    return v.kind === 'joining' ? v : null;
  });

  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  // Ionic's view events do not fire when this page is the first one loaded, so the first
  // load and polling also start from Angular's own lifecycle.
  ngOnInit(): void {
    this.enter();
  }

  ngOnDestroy(): void {
    this.leave();
  }

  ionViewWillEnter(): void {
    this.enter();
  }

  ionViewWillLeave(): void {
    this.leave();
  }

  private enter(): void {
    if (this.timer) return;
    this.selfName.set(this.store.profile()?.selfName ?? '');
    void this.load();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  private leave(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  protected show(view: View): void {
    this.error.set('');
    this.view.set(view);
  }

  protected spaced(code: string): string {
    return `${code.slice(0, 3)} ${code.slice(3)}`;
  }

  protected safetyOf(progress: InviteProgress): string {
    return progress.state === 'claimed' ? progress.safetyCode : '';
  }

  protected startChoice(progress: JoinProgress): {
    space: StartOfRelationship;
    mine: StartOfRelationship;
  } {
    if (progress.state !== 'chooseStart') throw new Error('No start choice');
    return progress;
  }

  protected async start(): Promise<void> {
    await this.run(async () => {
      await this.sharing.startSharing(this.selfName());
      const code = await this.sharing.createInvite();
      this.view.set({ kind: 'invite', code, progress: { state: 'waiting' } });
    });
  }

  protected async join(): Promise<void> {
    await this.run(async () => {
      const code = await this.sharing.claim(this.codeText(), this.selfName());
      this.joinSafety.set(code);
      this.view.set({ kind: 'joining', progress: { state: 'waiting', safetyCode: code } });
    });
  }

  protected async approve(): Promise<void> {
    await this.run(async () => {
      await this.sharing.approveInvite();
      await this.notice.show(this.t.t('sharing.approved'));
      this.view.set({ kind: 'member' });
    });
  }

  protected async decline(): Promise<void> {
    await this.run(async () => {
      await this.sharing.declineInvite();
      await this.notice.show(this.t.t('sharing.declined'));
      this.view.set({ kind: 'member' });
    });
  }

  protected async chooseStart(choice: 'space' | 'mine'): Promise<void> {
    await this.run(async () => this.showJoinProgress(await this.sharing.chooseStart(choice)));
  }

  protected async cancelJoin(): Promise<void> {
    await this.run(async () => {
      await this.sharing.cancelJoin();
      this.joinSafety.set(null);
      this.view.set({ kind: 'off' });
    });
  }

  protected async syncNow(): Promise<void> {
    this.syncStatus.set('');
    await this.run(async () => {
      const report = await this.sharing.syncNow();
      this.syncStatus.set(this.t.t(report.deferred ? 'sharing.syncDeferred' : 'sharing.synced'));
    });
  }

  protected async stopHere(): Promise<void> {
    const confirmed = await this.confirm.confirmDestructive(
      this.t.t('sharing.stopHereTitle'),
      this.t.t('sharing.stopHereBody'),
      this.t.t('sharing.stopHere'),
    );
    if (!confirmed) return;
    await this.run(async () => {
      await this.sharing.stopSharingHere();
      await this.notice.show(this.t.t('sharing.stopped'));
      this.view.set({ kind: 'off' });
    });
  }

  protected async copy(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      await this.notice.show(this.t.t('sharing.copied'));
    } catch {
      // Clipboard unavailable: the code stays selectable on screen.
    }
  }

  protected async share(code: string): Promise<void> {
    try {
      await Share.share({
        title: this.t.t('sharing.shareTitle'),
        text: this.t.t('sharing.shareText', { code }),
        dialogTitle: this.t.t('sharing.shareTitle'),
      });
    } catch {
      // Cancelled, or no share sheet (browser preview): nothing to do.
    }
  }

  private async load(): Promise<void> {
    try {
      const status = await this.sharing.refresh();
      if (status === 'off') return this.view.set({ kind: 'off' });
      if (status === 'memberWithoutKey') return this.view.set({ kind: 'noKey' });
      if (status === 'joining') return this.showJoinProgress(await this.sharing.checkJoin());
      const code = await this.sharing.currentInviteCode();
      if (!code) return this.view.set({ kind: 'member' });
      this.view.set({ kind: 'invite', code, progress: await this.sharing.checkInvite() });
      this.afterInviteCheck();
    } catch (error) {
      this.error.set(this.t.t(errorKey(error)));
      this.view.set({ kind: 'off' });
    }
  }

  /** Asks the server about the invite or join on screen; quiet about passing failures. */
  private async poll(): Promise<void> {
    const view = this.view();
    if (this.polling || this.busy()) return;
    const needsInvite = view.kind === 'invite' && view.progress.state === 'waiting';
    const needsJoin = view.kind === 'joining' && view.progress.state === 'waiting';
    if (!needsInvite && !needsJoin) return;
    this.polling = true;
    try {
      if (view.kind === 'invite') {
        this.view.set({ ...view, progress: await this.sharing.checkInvite() });
        this.afterInviteCheck();
      } else {
        await this.showJoinProgress(await this.sharing.checkJoin());
      }
    } catch {
      // Offline for a moment: the next round tries again.
    } finally {
      this.polling = false;
    }
  }

  private afterInviteCheck(): void {
    const view = this.view();
    if (view.kind === 'invite' && view.progress.state === 'gone') {
      this.error.set(this.t.t('sharing.inviteGone'));
      this.view.set({ kind: 'member' });
    }
  }

  private async showJoinProgress(progress: JoinProgress): Promise<void> {
    if (progress.state === 'waiting') this.joinSafety.set(progress.safetyCode);
    if (progress.state === 'joined') {
      const name = this.partnerName();
      await this.notice.show(
        name ? this.t.t('sharing.joined', { name }) : this.t.t('sharing.joinedNoName'),
      );
      this.view.set({ kind: 'member' });
      return;
    }
    if (progress.state === 'gone') {
      this.error.set(this.t.t('sharing.error.inviteUnavailable'));
      this.view.set({ kind: 'off' });
      return;
    }
    this.view.set({ kind: 'joining', progress });
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await work();
    } catch (error) {
      this.error.set(this.t.t(errorKey(error)));
    } finally {
      this.busy.set(false);
    }
  }
}

/** The message for a failure. Errors carry codes only, never data. */
export function errorKey(error: unknown): MessageKey {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 'nameRequired':
      return 'sharing.error.nameRequired';
    case 'invalidCode':
      return 'sharing.error.invalidCode';
    case 'inviteUnavailable':
      return 'sharing.error.inviteUnavailable';
    case 'alreadyInSpace':
    case 'personExists':
      return 'sharing.error.alreadyInSpace';
    case 'network':
      return 'sharing.error.network';
    default:
      return error instanceof TypeError ? 'sharing.error.network' : 'sharing.error.generic';
  }
}
