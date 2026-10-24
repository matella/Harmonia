import { computed, signal } from '@angular/core';

import type { SharingView } from '../app/core/services/sharing.service';

/** The sharing status for screens: unknown at first, then checked when needed. */
export function fakeSharingStatus(view: SharingView) {
  const status = signal<SharingView>('unknown');
  return {
    available: true,
    status,
    sharingOn: computed(() => status() !== 'off' && status() !== 'unknown'),
    ensureStatus: async () => {
      status.set(view);
      return view;
    },
  };
}
