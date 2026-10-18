import { Injectable, inject } from '@angular/core';

import type { AppSettings } from '../domain/models';
import { DatabaseService } from './database.service';
import { SyncService } from './sync.service';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly db = inject(DatabaseService);
  private readonly sync = inject(SyncService);

  /** Persists settings, then refreshes reminders and widgets (privacy, policy, theme). */
  async update(changes: Partial<AppSettings>): Promise<void> {
    await this.db.repos.settings.save(changes);
    await this.sync.afterChange();
  }
}
