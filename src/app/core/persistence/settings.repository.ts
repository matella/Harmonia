import { APP_LOCK_DELAYS } from '../domain/app-lock';
import type { Clock } from '../domain/clock';
import { isValidLocalTime } from '../domain/local-date';
import { DEFAULT_SETTINGS, type AppSettings } from '../domain/models';
import { isValidReminderOffset } from '../domain/validation';
import type { SqlDriver } from './sql-driver';

type Validators = { [K in keyof AppSettings]: (value: unknown) => value is AppSettings[K] };

const oneOf =
  <T extends string>(...values: T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (values as string[]).includes(value);
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const VALIDATORS: Validators = {
  theme: oneOf('system', 'light', 'dark'),
  accent: oneOf('berry', 'sage'),
  counterFormat: oneOf('calendar', 'days', 'weeks'),
  remindersEnabled: isBoolean,
  defaultReminderTime: isValidLocalTime,
  defaultReminderOffsets: (value): value is number[] =>
    Array.isArray(value) && value.length <= 8 && value.every(isValidReminderOffset),
  notificationsRevealTitles: isBoolean,
  widgetPrivacy: oneOf('normal', 'discreet', 'minimal'),
  widgetCounterMode: oneOf('days', 'calendar'),
  leapDayPolicy: oneOf('feb28', 'mar1'),
  timelineOrder: oneOf('oldest', 'newest'),
  togetherMonths: oneOf('off', 'key', 'every'),
  togetherDays: isBoolean,
  togetherReminders: isBoolean,
  language: oneOf('system', 'en', 'fr', 'nl'),
  usageSharing: isBoolean,
  usagePromptAnswered: isBoolean,
  appLock: isBoolean,
  appLockAfter: (value): value is AppSettings['appLockAfter'] =>
    typeof value === 'number' && (APP_LOCK_DELAYS as readonly number[]).includes(value),
};

/**
 * Key/value settings store. Each key is JSON-encoded and validated on read, so a
 * missing, unknown or corrupt value falls back to its default instead of breaking the
 * app. New settings only need a default and a validator — no migration.
 */
/** True for a known setting with a valid value. */
export function isValidSetting(key: string, value: unknown): key is keyof AppSettings {
  return key in VALIDATORS && VALIDATORS[key as keyof AppSettings](value);
}

export class SettingsRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: Clock,
  ) {}

  async load(): Promise<AppSettings> {
    const rows = await this.db.query<{ key: string; value: string }>('SELECT key, value FROM app_settings');
    const settings: AppSettings = { ...DEFAULT_SETTINGS, defaultReminderOffsets: [...DEFAULT_SETTINGS.defaultReminderOffsets] };
    for (const row of rows) {
      if (!(row.key in VALIDATORS)) continue;
      const key = row.key as keyof AppSettings;
      try {
        const value: unknown = JSON.parse(row.value);
        if (VALIDATORS[key](value)) (settings as unknown as Record<string, unknown>)[key] = value;
      } catch {
        // Corrupt value: keep the default.
      }
    }
    return settings;
  }

  async save(changes: Partial<AppSettings>): Promise<AppSettings> {
    const now = this.clock.now().toString();
    await this.db.transaction(async (tx) => {
      for (const [key, value] of Object.entries(changes)) {
        if (!(key in VALIDATORS) || !VALIDATORS[key as keyof AppSettings](value)) {
          throw new Error(`Invalid setting: ${key}`);
        }
        await tx.run(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [key, JSON.stringify(value), now],
        );
      }
    });
    return this.load();
  }
}
