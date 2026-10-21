import type { Clock } from '../domain/clock';
import type { Person, RelationshipProfile } from '../domain/models';
import type { ValidProfile } from '../domain/validation';
import { ChangeJournal } from './change-journal';
import { newId as defaultNewId, type IdFactory } from './ids';
import type { SqlDriver, SqlExecutor, SqlRow } from './sql-driver';

interface ProfileRow extends SqlRow {
  relationship_label: string | null;
  start_date: string;
  start_time: string | null;
  start_time_zone_id: string | null;
  calendar_time_zone_id: string;
  photo_path: string | null;
  created_at: string;
  updated_at: string;
}

interface PersonRow extends SqlRow {
  id: string;
  display_name: string | null;
  is_self: number;
  is_placeholder: number;
}

function toPerson(row: PersonRow): Person {
  return { id: row.id, displayName: row.display_name, isSelf: row.is_self === 1, isPlaceholder: row.is_placeholder === 1 };
}

/**
 * The single relationship profile (one row, id = 1) and the people in it. Names live in
 * `persons` since schema v2: the device owner (`is_self`) and the partner — on a solo
 * device a placeholder holding the name typed here.
 */
export class RelationshipRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: Clock,
    private readonly newId: IdFactory = defaultNewId,
    private readonly journal: ChangeJournal = new ChangeJournal(clock),
  ) {}

  async get(): Promise<RelationshipProfile | null> {
    const rows = await this.db.query<ProfileRow>('SELECT * FROM relationship_profile WHERE id = 1');
    const row = rows[0];
    if (!row) return null;
    const people = await this.persons();
    return {
      displayName: partnerOf(people)?.displayName ?? null,
      selfName: people.find((p) => p.isSelf)?.displayName ?? null,
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

  /** Active people, the device owner first. */
  async persons(): Promise<Person[]> {
    const rows = await this.db.query<PersonRow>(
      'SELECT id, display_name, is_self, is_placeholder FROM persons WHERE deleted_at IS NULL ORDER BY is_self DESC, created_at, id',
    );
    return rows.map(toPerson);
  }

  /** Creates or updates the profile and both names. `photoPath` undefined keeps the current photo. */
  async save(profile: ValidProfile, photoPath?: string | null): Promise<RelationshipProfile> {
    const now = this.clock.now().toString();
    const existing = await this.get();
    const nextPhoto = photoPath === undefined ? (existing?.photoPath ?? null) : photoPath;
    await this.db.transaction(async (tx) => {
      const self = await this.ensureSelf(tx, now);
      await this.setName(tx, self.id, profile.selfName, now);
      const partner = partnerOf(await this.personsIn(tx));
      if (partner) {
        await this.setName(tx, partner.id, profile.displayName, now);
      } else if (profile.displayName !== null) {
        const version = await this.journal.stamp(tx);
        const id = this.newId();
        await tx.run(
          `INSERT INTO persons (id, display_name, is_self, is_placeholder, version, created_at, updated_at)
           VALUES (?, ?, 0, 1, ?, ?, ?)`,
          [id, profile.displayName, version, now, now],
        );
        await this.journal.changed(tx, 'person', id, version);
      }

      const version = await this.journal.stamp(tx);
      await tx.run(
        `INSERT INTO relationship_profile
          (id, display_name, relationship_label, start_date, start_time, start_time_zone_id,
           calendar_time_zone_id, photo_path, created_at, updated_at, version, author_person_id)
         VALUES (1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           relationship_label = excluded.relationship_label,
           start_date = excluded.start_date,
           start_time = excluded.start_time,
           start_time_zone_id = excluded.start_time_zone_id,
           calendar_time_zone_id = excluded.calendar_time_zone_id,
           photo_path = excluded.photo_path,
           updated_at = excluded.updated_at,
           version = excluded.version,
           author_person_id = excluded.author_person_id`,
        [
          profile.relationshipLabel,
          profile.startDate,
          profile.startTime,
          profile.startTimeZoneId,
          profile.calendarTimeZoneId,
          nextPhoto,
          existing?.createdAt ?? now,
          now,
          version,
          self.id,
        ],
      );
      await this.journal.changed(tx, 'profile', '1', version);
    });
    const saved = await this.get();
    if (!saved) throw new Error('Profile was not saved');
    return saved;
  }

  private async personsIn(tx: SqlExecutor): Promise<Person[]> {
    const rows = await tx.query<PersonRow>(
      'SELECT id, display_name, is_self, is_placeholder FROM persons WHERE deleted_at IS NULL ORDER BY is_self DESC, created_at, id',
    );
    return rows.map(toPerson);
  }

  private async ensureSelf(tx: SqlExecutor, now: string): Promise<Person> {
    const existing = (await this.personsIn(tx)).find((p) => p.isSelf);
    if (existing) return existing;
    const version = await this.journal.stamp(tx);
    const id = this.newId();
    await tx.run(
      `INSERT INTO persons (id, display_name, is_self, is_placeholder, version, created_at, updated_at)
       VALUES (?, NULL, 1, 0, ?, ?, ?)`,
      [id, version, now, now],
    );
    await this.journal.changed(tx, 'person', id, version);
    return { id, displayName: null, isSelf: true, isPlaceholder: false };
  }

  /** Writes a name only when it changed, so unrelated profile edits don't create person versions. */
  private async setName(tx: SqlExecutor, personId: string, name: string | null, now: string): Promise<void> {
    const current = await tx.query<{ display_name: string | null }>('SELECT display_name FROM persons WHERE id = ?', [personId]);
    if (current[0]?.display_name === name) return;
    const version = await this.journal.stamp(tx);
    await tx.run('UPDATE persons SET display_name = ?, version = ?, updated_at = ? WHERE id = ?', [name, version, now, personId]);
    await this.journal.changed(tx, 'person', personId, version);
  }
}

/** The partner: on a solo device the placeholder; once shared, the other real person. */
function partnerOf(people: readonly Person[]): Person | undefined {
  return people.find((p) => !p.isSelf && !p.isPlaceholder) ?? people.find((p) => !p.isSelf);
}
