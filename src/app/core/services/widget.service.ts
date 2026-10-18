import { Injectable, inject } from '@angular/core';

import { buildWidgetSnapshot, emptyWidgetSnapshot, snapshotFingerprint, type WidgetSnapshot } from '../domain/widget-snapshot';
import { HarmoniaWidgets } from '../platform/widget-bridge';
import { AppStore } from '../state/app-store';
import { CLOCK } from './tokens';

/**
 * Keeps the native widget/watch snapshot in sync with persisted data. Writes (and the
 * resulting reload requests, which count against OS budgets) only happen when the
 * snapshot content actually changed.
 */
@Injectable({ providedIn: 'root' })
export class WidgetService {
  private readonly store = inject(AppStore);
  private readonly clock = inject(CLOCK);
  private lastFingerprint: string | null = null;

  current(): WidgetSnapshot {
    return buildWidgetSnapshot({
      profile: this.store.profile(),
      milestones: this.store.milestones(),
      settings: this.store.settings(),
      clock: this.clock,
    });
  }

  async refresh(): Promise<boolean> {
    const snapshot = this.current();
    const fingerprint = snapshotFingerprint(snapshot);
    if (fingerprint === this.lastFingerprint) return false;
    await HarmoniaWidgets.writeSnapshot({ json: JSON.stringify(snapshot) });
    this.lastFingerprint = fingerprint;
    return true;
  }

  /** Asks the OS to re-render widgets, e.g. after the calendar day changed. */
  async reload(): Promise<void> {
    await HarmoniaWidgets.reloadAll();
  }

  /** Replaces the snapshot with the privacy-safe placeholder. */
  async clear(): Promise<void> {
    const snapshot = emptyWidgetSnapshot(this.clock.now().toString());
    await HarmoniaWidgets.writeSnapshot({ json: JSON.stringify(snapshot) });
    this.lastFingerprint = snapshotFingerprint(snapshot);
  }
}
