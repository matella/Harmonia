import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';

import { FakeNotificationPort } from '../../../testing/fake-notification-port';
import { MutableClock } from '../../core/domain/clock';
import { SharingService, type SharingView } from '../../core/services/sharing.service';
import { CLOCK, NOTIFICATION_PORT } from '../../core/services/tokens';
import { AppStore } from '../../core/state/app-store';
import type { InviteProgress, JoinProgress } from '../../core/sync/sharing';
import { ConfirmService } from '../../shared/services/confirm.service';
import { errorKey, SharingPage } from './sharing.page';

/** Stands in for the server-backed service; records what the screen asked for. */
class FakeSharing {
  readonly available = true;
  readonly status = signal<SharingView>('off');
  readonly calls: string[] = [];
  view: SharingView = 'off';
  inviteCode: string | null = null;
  invite: InviteProgress = { state: 'waiting' };
  join: JoinProgress = { state: 'waiting', safetyCode: '942308' };
  claimError: unknown = null;

  async refresh(): Promise<SharingView> {
    return this.view;
  }
  async currentInvite(): Promise<{ code: string; forMe: boolean } | null> {
    return this.inviteCode ? { code: this.inviteCode, forMe: this.inviteForMe } : null;
  }
  inviteForMe = false;
  async createInvite(forMe = false): Promise<string> {
    this.calls.push(forMe ? 'invite:me' : 'invite:partner');
    return 'H1.code';
  }
  async checkInvite(): Promise<InviteProgress> {
    return this.invite;
  }
  async checkJoin(): Promise<JoinProgress> {
    return this.join;
  }
  async claim(code: string, name: string): Promise<string> {
    this.calls.push(`claim:${name}`);
    if (this.claimError) throw this.claimError;
    return '942308';
  }
  async approveInvite(): Promise<void> {
    this.calls.push('approve');
  }
  async chooseStart(choice: 'space' | 'mine'): Promise<JoinProgress> {
    this.calls.push(`choose:${choice}`);
    return { state: 'joined' };
  }
  syncResult: 'ended' | { deferred: boolean; awaitingKey?: boolean } = { deferred: false };
  async syncNow(): Promise<'ended' | { deferred: boolean; awaitingKey?: boolean }> {
    this.calls.push('sync');
    return this.syncResult;
  }
  async leave(): Promise<void> {
    this.calls.push('leave');
  }
  devices: { id: string; platform: string; thisDevice: boolean; pendingRemoval?: boolean }[] = [];
  async myDevices(): Promise<
    { id: string; platform: string; thisDevice: boolean; pendingRemoval?: boolean }[]
  > {
    return this.devices;
  }
  async removeDevice(id: string): Promise<void> {
    this.calls.push(`remove:${id}`);
    this.devices = this.devices.filter((d) => d.id !== id);
  }
  async startSharing(name: string): Promise<void> {
    this.calls.push(`start:${name}`);
    this.view = 'member';
  }
  partner = true;
  async hasPartner(): Promise<boolean> {
    return this.partner;
  }
  recovery: 'set' | 'missing' | 'saving' = 'set';
  async recoveryStatus(): Promise<'set' | 'missing' | 'saving'> {
    return this.recovery;
  }
  readonly key = {
    display: 'K7QX2-ABCDE-FGH1J-KMNPQ-RSTVW-XYZ01-23456-789AB',
    groups: ['K7QX2', 'ABCDE', 'FGH1J', 'KMNPQ', 'RSTVW', 'XYZ01', '23456', '789AB'],
    ask: [2, 5] as [number, number],
  };
  async createRecoveryKey() {
    this.calls.push('newKey');
    return this.key;
  }
  async confirmRecoveryKey(answers: readonly [string, string]): Promise<boolean> {
    this.calls.push(`confirm:${answers.join(',')}`);
    if (answers[0] !== 'FGH1J') {
      throw Object.assign(new Error('mismatch'), { code: 'recoveryMismatch' });
    }
    this.recovery = 'set';
    return true;
  }
  async discardRecoveryKey(): Promise<void> {
    this.calls.push('discardKey');
  }
  async recover(text: string): Promise<void> {
    this.calls.push(`recover:${text}`);
    this.view = 'member';
  }
}

/** Answers every confirmation, and records what it was asked. */
class FakeConfirm {
  answer = true;
  asked: string[] = [];
  async confirmDestructive(header: string): Promise<boolean> {
    this.asked.push(header);
    return this.answer;
  }
}

describe('SharingPage', () => {
  let fake: FakeSharing;
  let confirm: FakeConfirm;

  beforeEach(() => {
    fake = new FakeSharing();
    confirm = new FakeConfirm();
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular(),
        provideRouter([]),
        { provide: NOTIFICATION_PORT, useValue: new FakeNotificationPort() },
        { provide: CLOCK, useValue: new MutableClock('2026-10-23T08:00:00Z', 'Europe/Brussels') },
        { provide: SharingService, useValue: fake },
        { provide: ConfirmService, useValue: confirm },
      ],
    });
    TestBed.inject(AppStore).profile.set({
      displayName: 'Sam',
      selfName: 'Alex',
      relationshipLabel: null,
      startDate: '2024-06-14',
      startTime: null,
      startTimeZoneId: null,
      calendarTimeZoneId: 'Europe/Brussels',
      photoPath: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });

  async function render(): Promise<{ fixture: ComponentFixture<SharingPage>; el: HTMLElement }> {
    const fixture = TestBed.createComponent(SharingPage);
    fixture.detectChanges();
    // The first load takes several awaited steps; settle until it has left "loading".
    for (let i = 0; i < 20 && fixture.nativeElement.querySelector('ion-spinner'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fixture.whenStable();
      fixture.detectChanges();
    }
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const buttons = (el: HTMLElement) =>
    [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
  const click = async (fixture: ComponentFixture<SharingPage>, label: string) => {
    const el = fixture.nativeElement as HTMLElement;
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
    if (!button) throw new Error(`No button "${label}"`);
    button.click();
    await settle(fixture);
  };
  /** Lets awaited steps (server calls, toasts) finish and the view update. */
  const settle = async (fixture: ComponentFixture<SharingPage>) => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fixture.whenStable();
      fixture.detectChanges();
    }
  };

  it('offers to invite or to join when sharing is off', async () => {
    const { fixture, el } = await render();
    expect(buttons(el)).toEqual([
      'Invite your partner',
      'Join with a code',
      'Recover with your recovery key',
    ]);
    await click(fixture, 'Invite your partner');
    expect((el.querySelector('#s-name') as HTMLInputElement).value).toBe('Alex');
    fixture.destroy();
  });

  it('explains a failed join in words, never as a raw error', async () => {
    fake.claimError = Object.assign(new Error('Sharing: invalidCode'), { code: 'invalidCode' });
    const { fixture, el } = await render();
    await click(fixture, 'Join with a code');
    await click(fixture, 'Join');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'doesn’t look like an invite code',
    );
    expect(fake.calls).toEqual(['claim:Alex']);
    fixture.destroy();
  });

  it('shows the claim with its safety code and accepts it', async () => {
    fake.view = 'member';
    fake.inviteCode = 'H1.code';
    fake.invite = { state: 'claimed', safetyCode: '942308' };
    const { fixture, el } = await render();
    expect(el.textContent).toContain('A device wants to join');
    expect(el.querySelector('.safety__digits')?.textContent?.trim()).toBe('942 308');
    expect(el.querySelector('.safety')?.getAttribute('aria-label')).toBe('Safety code 942 308');
    await click(fixture, 'The codes match, accept');
    expect(fake.calls).toEqual(['approve']);
    expect(el.textContent).toContain('Shared with Sam');
    fixture.destroy();
  });

  it('lets the joiner keep their own start date when the two differ', async () => {
    fake.view = 'joining';
    fake.join = {
      state: 'chooseStart',
      space: { startDate: '2026-10-14', startTime: null, startTimeZoneId: null },
      mine: { startDate: '2026-10-06', startTime: null, startTimeZoneId: null },
    };
    const { fixture, el } = await render();
    // The test environment formats dates in US English.
    expect(buttons(el)).toEqual(['Your partner’s: October 14, 2026', 'Yours: October 6, 2026']);
    await click(fixture, 'Yours:');
    // A partner who joined makes their own recovery key next (§8).
    expect(fake.calls).toEqual(['choose:mine', 'newKey']);
    expect(el.textContent).toContain('Your recovery key');
    fixture.destroy();
  });

  it('creates an invite for one of my own devices, with its own wording', async () => {
    fake.view = 'member';
    const { fixture, el } = await render();
    await click(fixture, 'Add one of my devices');
    expect(fake.calls).toEqual(['invite:me']);
    expect(el.textContent).toContain('Enter this code on your other device');
    fixture.destroy();
  });

  it('lists my devices and removes another one after asking', async () => {
    fake.view = 'member';
    fake.devices = [
      { id: 'me', platform: 'android', thisDevice: true },
      { id: 'tablet', platform: 'ios', thisDevice: false },
    ];
    const { fixture, el } = await render();
    await settle(fixture);
    expect(el.textContent).toContain('This device');
    expect(el.textContent).toContain('Your iPhone or iPad');
    const removes = [...el.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Remove',
    );
    expect(removes).toHaveLength(1); // never this device
    removes[0].click();
    await settle(fixture);
    expect(confirm.asked).toEqual(['Remove Your iPhone or iPad?']);
    expect(fake.calls).toEqual(['remove:tablet']);
    expect(el.textContent).not.toContain('Your iPhone or iPad');
    fixture.destroy();
  });

  it('asks before leaving the space, then shows sharing as off', async () => {
    fake.view = 'member';
    const { fixture, el } = await render();
    expect(el.textContent).toContain('Leave the shared space');
    confirm.answer = false;
    await click(fixture, 'Leave');
    expect(fake.calls).toEqual([]);
    confirm.answer = true;
    await click(fixture, 'Leave');
    expect(confirm.asked).toEqual(['Leave the shared space?', 'Leave the shared space?']);
    expect(fake.calls).toEqual(['leave']);
    expect(buttons(el)).toEqual([
      'Invite your partner',
      'Join with a code',
      'Recover with your recovery key',
    ]);
    fixture.destroy();
  });

  it('switches to solo when a sync learns that sharing has ended', async () => {
    fake.view = 'member';
    fake.syncResult = 'ended';
    const { fixture, el } = await render();
    await click(fixture, 'Sync now');
    expect(buttons(el)).toEqual([
      'Invite your partner',
      'Join with a code',
      'Recover with your recovery key',
    ]);
    fixture.destroy();
  });

  it('offers a way back to solo when this device has lost its key', async () => {
    fake.view = 'memberWithoutKey';
    const { fixture, el } = await render();
    expect(el.textContent).toContain('This device can’t read the shared space');
    expect(buttons(el)).toEqual(['Stop sharing on this device']);
    fixture.destroy();
  });
});

describe('SharingPage recovery key', () => {
  let fake: FakeSharing;

  beforeEach(() => {
    fake = new FakeSharing();
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular(),
        provideRouter([]),
        { provide: NOTIFICATION_PORT, useValue: new FakeNotificationPort() },
        { provide: CLOCK, useValue: new MutableClock('2026-10-23T08:00:00Z', 'Europe/Brussels') },
        { provide: SharingService, useValue: fake },
        { provide: ConfirmService, useValue: new FakeConfirm() },
      ],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(SharingPage);
    fixture.detectChanges();
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }
  const settle = async (fixture: ComponentFixture<SharingPage>) => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fixture.whenStable();
      fixture.detectChanges();
    }
  };
  const click = async (fixture: ComponentFixture<SharingPage>, label: string) => {
    const el = fixture.nativeElement as HTMLElement;
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
    if (!button) throw new Error(`No button "${label}"`);
    button.click();
    await settle(fixture);
  };
  const type = (el: HTMLElement, selector: string, value: string) => {
    const input = el.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  it('shows the new key after turning sharing on, and invites only once it is confirmed', async () => {
    const { fixture, el } = await render();
    await click(fixture, 'Invite your partner');
    type(el, '#s-name', 'Alex');
    await click(fixture, 'Create an invite');
    expect(fake.calls).toEqual(['start:Alex', 'newKey']);
    const groups = [...el.querySelectorAll('.key__group')].map((g) =>
      [...g.querySelectorAll('span')].map((part) => part.textContent?.trim()).join(' '),
    );
    expect(groups[0]).toBe('1 K7QX2');
    expect(groups).toHaveLength(8);
    expect(el.textContent).not.toContain('Cancel'); // setting up can't be skipped
    await click(fixture, 'I’ve saved it');
    expect(el.textContent).toContain('Type groups 3 and 6 of your key');
    // A mismatch stays on the form, in words.
    type(el, '#rc-0', 'XXXXX');
    type(el, '#rc-1', 'XYZ01');
    await click(fixture, 'Confirm');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('don’t match the key');
    type(el, '#rc-0', 'FGH1J');
    await click(fixture, 'Confirm');
    expect(fake.calls.slice(-2)).toEqual(['confirm:FGH1J,XYZ01', 'invite:partner']);
    expect(el.textContent).toContain('Your invite code');
    fixture.destroy();
  });

  it('keeps asking for a missing key, and offers Replace once there is one', async () => {
    fake.view = 'member';
    fake.recovery = 'missing';
    const { fixture, el } = await render();
    expect(el.textContent).toContain('Create your recovery key');
    expect(el.textContent).not.toContain('Replace recovery key');
    fixture.destroy();

    fake.recovery = 'set';
    const second = await render();
    expect(second.el.textContent).not.toContain('Create your recovery key');
    await click(second.fixture, 'Replace recovery key');
    expect(second.el.textContent).toContain('replaces your old one once you confirm it');
    await click(second.fixture, 'Cancel');
    expect(fake.calls).toEqual(['newKey', 'discardKey']);
    second.fixture.destroy();
  });

  it('can still invite after leaving the key screen before any partner joined', async () => {
    fake.view = 'member';
    fake.recovery = 'missing';
    fake.partner = false;
    const { fixture, el } = await render();
    await click(fixture, 'Create recovery key');
    await click(fixture, 'I’ve saved it');
    type(el, '#rc-0', 'FGH1J');
    type(el, '#rc-1', 'XYZ01');
    await click(fixture, 'Confirm');
    expect(el.textContent).toContain('Replace recovery key');
    await click(fixture, 'Invite your partner');
    expect(fake.calls.at(-1)).toBe('invite:partner');
    expect(el.textContent).toContain('Your invite code');
    fixture.destroy();
  });

  it('suggests replacing the key after removing a device', async () => {
    fake.view = 'member';
    fake.devices = [
      { id: 'me', platform: 'android', thisDevice: true },
      { id: 'old', platform: 'android', thisDevice: false },
    ];
    const { fixture, el } = await render();
    expect(el.textContent).not.toContain('If it could have shown your recovery key');
    await click(fixture, 'Remove');
    expect(el.textContent).toContain('If it could have shown your recovery key');
    fixture.destroy();
  });

  it('recovers from the off screen with the key typed in', async () => {
    const { fixture, el } = await render();
    await click(fixture, 'Recover with your recovery key');
    type(el, '#r-key', 'k7qx2 abcde');
    await click(fixture, 'Recover');
    expect(fake.calls).toEqual(['recover:k7qx2 abcde']);
    expect(el.textContent).toContain('Leave the shared space');
    fixture.destroy();
  });
});

describe('sharing error messages', () => {
  it('maps codes to messages and treats fetch failures as network trouble', () => {
    const coded = (code: string) => Object.assign(new Error(code), { code });
    expect(errorKey(coded('inviteUnavailable'))).toBe('sharing.error.inviteUnavailable');
    expect(errorKey(coded('alreadyInSpace'))).toBe('sharing.error.alreadyInSpace');
    expect(errorKey(coded('network'))).toBe('sharing.error.network');
    expect(errorKey(coded('unknownRecoveryKey'))).toBe('sharing.error.unknownRecoveryKey');
    expect(errorKey(coded('recoveryNotReady'))).toBe('sharing.error.recoveryNotReady');
    expect(errorKey(new TypeError('Failed to fetch'))).toBe('sharing.error.network');
    expect(errorKey(new Error('boom'))).toBe('sharing.error.generic');
    expect(errorKey(null)).toBe('sharing.error.generic');
  });
});
