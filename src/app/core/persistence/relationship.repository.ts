import type { Clock } from '../domain/clock';
import type { RelationshipProfile } from '../domain/models';
import type { ValidProfile } from '../domain/validation';
import type { SqlDriver, SqlRow } from './sql-driver';

interface ProfileRow extends SqlRow {
  display_name: string | null;
  relationship_label: string | null;
  start_date: string;
  start_time: string | null;
  start_time_zone_id: string | null;
  calendar_time_zone_id: string;
  photo_path: string | null;
  created_at: string;
  updated_at: string;
}

function toProfile(row: ProfileRow): RelationshipProfile {
  return {
    displayName: row.display_name,
    relationshipLabel: row.relationship_label,
    startDate: row.start_date,
    startTime: row.start_time,
    startTimeZoneId: row.start_time_zone_id,
    calendarTimeZoneId: row.calendar_time_zone_id,
    photoPath: row.photo_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The single relationship profile (one row, id = 1, in v1). */
export class RelationshipRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: Clock,
  ) {}

  async get(): Promise<RelationshipProfile | null> {
    const rows = await this.db.query<ProfileRow>('SELECT * FROM relationship_profile WHERE id = 1');
    return rows[0] ? toProfile(rows[0]) : null;
  }

  /** Creates or updates the profile. `photoPath` undefined keeps the current photo. */
  async save(profile: ValidProfile, photoPath?: string | null): Promise<RelationshipProfile> {
    const now = this.clock.now().toString();
    const existing = await this.get();
    const nextPhoto = photoPath === undefined ? (existing?.photoPath ?? null) : photoPath;
    await this.db.run(
      `INSERT INTO relationship_profile
        (id, display_name, relationship_label, start_date, start_time, start_time_zone_id,
         calendar_time_zone_id, photo_path, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         display_name = excluded.display_name,
         relationship_label = excluded.relationship_label,
         start_date = excluded.start_date,
         start_time = excluded.start_time,
         start_time_zone_id = excluded.start_time_zone_id,
         calendar_time_zone_id = excluded.calendar_time_zone_id,
         photo_path = excluded.photo_path,
         updated_at = excluded.updated_at`,
      [
        profile.displayName,
        profile.relationshipLabel,
        profile.startDate,
        profile.startTime,
        profile.startTimeZoneId,
        profile.calendarTimeZoneId,
        nextPhoto,
        existing?.createdAt ?? now,
        now,
      ],
    );
    const saved = await this.get();
    if (!saved) throw new Error('Profile was not saved');
    return saved;
  }
}
