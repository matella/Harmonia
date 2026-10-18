import { isValidIsoDate, isValidLocalTime } from './local-date';
import {
  DEFAULT_SETTINGS,
  MILESTONE_CATEGORIES,
  type AppSettings,
  type IsoInstant,
  type Memory,
  type Milestone,
  type ReminderRule,
  type RelationshipProfile,
} from './models';

export const EXPORT_FORMAT = 'harmonia-export';
export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_JSON_NAME = 'harmonia-export.json';
/** Folder inside the archive that holds copies of app-private media. */
export const EXPORT_MEDIA_DIR = 'media';

export interface ExportedMedia {
  id: string;
  /** Path inside the archive (media/<file>), or null if the file could not be read. */
  archivePath: string | null;
  sortOrder: number;
  createdAt: IsoInstant;
}

export interface ExportedMemory extends Omit<Memory, 'media'> {
  media: ExportedMedia[];
}

export interface ExportDocument {
  format: typeof EXPORT_FORMAT;
  schemaVersion: number;
  exportedAt: IsoInstant;
  appVersion: string;
  databaseSchemaVersion: number;
  profile: (Omit<RelationshipProfile, 'photoPath'> & { photoArchivePath: string | null }) | null;
  settings: AppSettings;
  milestones: Omit<Milestone, 'photoPath'>[];
  reminderRules: ReminderRule[];
  memories: ExportedMemory[];
  /** True when every referenced media file was included in the archive. */
  mediaComplete: boolean;
}

export interface ExportSource {
  profile: RelationshipProfile | null;
  settings: AppSettings;
  milestones: readonly Milestone[];
  reminderRules: readonly ReminderRule[];
  memories: readonly Memory[];
}

export interface ExportMeta {
  exportedAt: IsoInstant;
  appVersion: string;
  databaseSchemaVersion: number;
}

/** Maps an app-private relative path to its location inside the archive. */
export function archivePathFor(privatePath: string): string {
  const name = privatePath.split('/').pop() ?? privatePath;
  return `${EXPORT_MEDIA_DIR}/${name}`;
}

/**
 * Builds the JSON document. `includedFiles` lists app-private paths whose bytes were
 * successfully added to the archive; anything else is reported via mediaComplete.
 */
export function buildExportDocument(
  source: ExportSource,
  meta: ExportMeta,
  includedFiles: ReadonlySet<string>,
): ExportDocument {
  let mediaComplete = true;
  const mapPath = (path: string | null): string | null => {
    if (!path) return null;
    if (includedFiles.has(path)) return archivePathFor(path);
    mediaComplete = false;
    return null;
  };

  const profile = source.profile
    ? (({ photoPath, ...rest }) => ({ ...rest, photoArchivePath: mapPath(photoPath) }))(source.profile)
    : null;

  const memories: ExportedMemory[] = source.memories.map((memory) => ({
    ...memory,
    media: memory.media.map((m) => ({
      id: m.id,
      archivePath: mapPath(m.filePath),
      sortOrder: m.sortOrder,
      createdAt: m.createdAt,
    })),
  }));

  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: meta.exportedAt,
    appVersion: meta.appVersion,
    databaseSchemaVersion: meta.databaseSchemaVersion,
    profile,
    settings: { ...source.settings },
    milestones: source.milestones.map(({ photoPath: _photo, ...rest }) => rest),
    reminderRules: [...source.reminderRules],
    memories,
    mediaComplete,
  };
}

export type ParseResult = { ok: true; document: ExportDocument } | { ok: false; reason: ParseFailure };
export type ParseFailure = 'notJson' | 'wrongFormat' | 'unsupportedVersion' | 'invalidContent';

/**
 * Validates an export document read back from an archive. Newer schema versions are
 * rejected rather than guessed at; older ones would be migrated here.
 */
export function parseExportDocument(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'notJson' };
  }
  if (!isRecord(raw) || raw['format'] !== EXPORT_FORMAT) return { ok: false, reason: 'wrongFormat' };
  const version = raw['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'invalidContent' };
  }
  if (version > EXPORT_SCHEMA_VERSION) return { ok: false, reason: 'unsupportedVersion' };

  const milestones = raw['milestones'];
  const memories = raw['memories'];
  const rules = raw['reminderRules'];
  if (!Array.isArray(milestones) || !Array.isArray(memories) || !Array.isArray(rules)) {
    return { ok: false, reason: 'invalidContent' };
  }
  const profile = raw['profile'];
  if (profile !== null && !(isRecord(profile) && isValidIsoDate(profile['startDate']))) {
    return { ok: false, reason: 'invalidContent' };
  }
  const milestonesValid = milestones.every(
    (m) =>
      isRecord(m) &&
      typeof m['id'] === 'string' &&
      typeof m['title'] === 'string' &&
      isValidIsoDate(m['eventDate']) &&
      (MILESTONE_CATEGORIES as readonly unknown[]).includes(m['category']),
  );
  const memoriesValid = memories.every(
    (m) => isRecord(m) && typeof m['id'] === 'string' && isValidIsoDate(m['memoryDate']) && Array.isArray(m['media']),
  );
  const rulesValid = rules.every(
    (r) =>
      isRecord(r) &&
      typeof r['milestoneId'] === 'string' &&
      typeof r['offsetDays'] === 'number' &&
      isValidLocalTime(r['localTime']),
  );
  if (!milestonesValid || !memoriesValid || !rulesValid) return { ok: false, reason: 'invalidContent' };

  const settings = isRecord(raw['settings']) ? raw['settings'] : {};
  const document = {
    ...(raw as unknown as ExportDocument),
    settings: { ...DEFAULT_SETTINGS, ...(settings as Partial<AppSettings>) },
  };
  return { ok: true, document };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
