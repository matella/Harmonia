import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';

import { CapacitorSqliteDriver } from '../persistence/capacitor-sqlite-driver';
import { DataRepository } from '../persistence/data.repository';
import { newId } from '../persistence/ids';
import { MemoryRepository } from '../persistence/memory.repository';
import { MilestoneRepository } from '../persistence/milestone.repository';
import { migrate, type MigrationResult } from '../persistence/migrations';
import { RelationshipRepository } from '../persistence/relationship.repository';
import { SettingsRepository } from '../persistence/settings.repository';
import type { SqlDriver } from '../persistence/sql-driver';
import { SqlJsDriver } from '../persistence/sqljs-driver';
import { webDbStore } from '../platform/web-db-store';
import { CLOCK } from './tokens';

const DATABASE_NAME = 'harmonia';

export interface Repositories {
  profile: RelationshipRepository;
  milestones: MilestoneRepository;
  memories: MemoryRepository;
  settings: SettingsRepository;
  data: DataRepository;
}

/** Opens the platform database, applies migrations and exposes repositories. */
@Injectable({ providedIn: 'root' })
export class DatabaseService {
  private readonly clock = inject(CLOCK);
  private repositories: Repositories | null = null;
  private driver: SqlDriver | null = null;
  migration: MigrationResult | null = null;

  get repos(): Repositories {
    if (!this.repositories) throw new Error('Database not opened');
    return this.repositories;
  }

  async open(): Promise<void> {
    if (this.repositories) return;
    const driver = Capacitor.isNativePlatform() ? await CapacitorSqliteDriver.open(DATABASE_NAME) : await openWebDriver();
    this.migration = await migrate(driver, undefined, () => this.clock.now().toString());
    this.driver = driver;
    this.repositories = {
      profile: new RelationshipRepository(driver, this.clock),
      milestones: new MilestoneRepository(driver, this.clock, newId),
      memories: new MemoryRepository(driver, this.clock, newId),
      settings: new SettingsRepository(driver, this.clock),
      data: new DataRepository(driver),
    };
  }

  async close(): Promise<void> {
    await this.driver?.close();
    this.driver = null;
    this.repositories = null;
  }
}

async function openWebDriver(): Promise<SqlDriver> {
  const key = `${DATABASE_NAME}.sqlite`;
  return SqlJsDriver.open({
    initialBytes: await webDbStore.get(key),
    locateFile: (file) => `assets/sqljs/${file}`,
    persist: (bytes) => webDbStore.set(key, bytes),
  });
}
