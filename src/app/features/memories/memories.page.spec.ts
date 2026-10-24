import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';

import { FakeNotificationPort } from '../../../testing/fake-notification-port';
import { fakeSharingStatus } from '../../../testing/fake-sharing';
import type { SharingView } from '../../core/services/sharing.service';
import { SharingService } from '../../core/services/sharing.service';
import { NOTIFICATION_PORT } from '../../core/services/tokens';
import { MemoriesPage } from './memories.page';

async function emptyText(view: SharingView): Promise<string> {
  TestBed.configureTestingModule({
    providers: [
      provideIonicAngular(),
      provideRouter([]),
      { provide: NOTIFICATION_PORT, useValue: new FakeNotificationPort() },
      { provide: SharingService, useValue: fakeSharingStatus(view) },
    ],
  });
  const fixture = TestBed.createComponent(MemoriesPage);
  fixture.componentInstance.ionViewWillEnter();
  await fixture.whenStable();
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

describe('MemoriesPage', () => {
  it('says memories stay on this device when not sharing', async () => {
    expect(await emptyText('off')).toContain('Memories stay private on this device.');
  });

  it('says they are shared only with the partner while sharing', async () => {
    const text = await emptyText('member');
    expect(text).toContain('Memories are shared only with your partner, end-to-end encrypted.');
    expect(text).not.toContain('on this device');
  });
});
