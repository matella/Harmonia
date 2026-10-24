import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';

import { FakeNotificationPort } from '../../../testing/fake-notification-port';
import { fakeSharingStatus } from '../../../testing/fake-sharing';
import { MutableClock } from '../../core/domain/clock';
import type { TrashItem } from '../../core/domain/models';
import { SharingService, type SharingView } from '../../core/services/sharing.service';
import { CLOCK, NOTIFICATION_PORT } from '../../core/services/tokens';
import { TrashService } from '../../core/services/trash.service';
import { ConfirmService } from '../../shared/services/confirm.service';
import { TrashPage } from './trash.page';

const item: TrashItem = {
  kind: 'memory',
  id: 'm1',
  title: 'Beach day',
  date: '2026-07-04',
  deletedAt: '2026-10-20T08:00:00Z',
  memoryCount: 0,
  photoCount: 1,
};

function setup(view: SharingView) {
  const messages: string[] = [];
  const deleted: string[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideIonicAngular(),
      provideRouter([]),
      { provide: NOTIFICATION_PORT, useValue: new FakeNotificationPort() },
      { provide: CLOCK, useValue: new MutableClock('2026-10-24T08:00:00Z', 'Europe/Brussels') },
      { provide: SharingService, useValue: fakeSharingStatus(view) },
      {
        provide: TrashService,
        useValue: {
          items: signal([item]),
          refresh: async () => [item],
          deleteForever: async (i: TrashItem) => void deleted.push(i.id),
        },
      },
      {
        provide: ConfirmService,
        useValue: {
          confirmDestructive: async (_title: string, message: string) => {
            messages.push(message);
            return true;
          },
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(TrashPage);
  fixture.detectChanges();
  return { fixture, messages, deleted };
}

async function pressDeleteForever(fixture: ReturnType<typeof setup>['fixture']): Promise<void> {
  const button = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Delete forever',
  )!;
  button.click();
  await fixture.whenStable();
}

describe('TrashPage', () => {
  it('says Delete forever removes it from this device when not sharing', async () => {
    const { fixture, messages, deleted } = setup('off');
    await pressDeleteForever(fixture);
    expect(messages).toEqual([
      'This removes it and its photos from this device. This can’t be undone.',
    ]);
    expect(deleted).toEqual(['m1']);
  });

  it('says it also leaves the partner’s devices while sharing', async () => {
    const { fixture, messages } = setup('member');
    await pressDeleteForever(fixture);
    expect(messages).toEqual([
      'This removes it and its photos from your devices and your partner’s. This can’t be undone.',
    ]);
  });
});
