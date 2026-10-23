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
  async currentInviteCode(): Promise<string | null> {
    return this.inviteCode;
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
  syncResult: 'ended' | { deferred: boolean } = { deferred: false };
  async syncNow(): Promise<'ended' | { deferred: boolean }> {
    this.calls.push('sync');
    return this.syncResult;
  }
  async leave(): Promise<void> {
    this.calls.push('leave');
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
    expect(buttons(el)).toEqual(['Invite your partner', 'Join with a code']);
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
    expect(fake.calls).toEqual(['choose:mine']);
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
    expect(buttons(el)).toEqual(['Invite your partner', 'Join with a code']);
    fixture.destroy();
  });

  it('switches to solo when a sync learns that sharing has ended', async () => {
    fake.view = 'member';
    fake.syncResult = 'ended';
    const { fixture, el } = await render();
    await click(fixture, 'Sync now');
    expect(buttons(el)).toEqual(['Invite your partner', 'Join with a code']);
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

describe('sharing error messages', () => {
  it('maps codes to messages and treats fetch failures as network trouble', () => {
    const coded = (code: string) => Object.assign(new Error(code), { code });
    expect(errorKey(coded('inviteUnavailable'))).toBe('sharing.error.inviteUnavailable');
    expect(errorKey(coded('alreadyInSpace'))).toBe('sharing.error.alreadyInSpace');
    expect(errorKey(coded('network'))).toBe('sharing.error.network');
    expect(errorKey(new TypeError('Failed to fetch'))).toBe('sharing.error.network');
    expect(errorKey(new Error('boom'))).toBe('sharing.error.generic');
    expect(errorKey(null)).toBe('sharing.error.generic');
  });
});
