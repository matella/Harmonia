import type { Temporal } from './temporal';
import { EXPORT_MEDIA_DIR, type ExportDocument } from './export-format';
import type { AppSettings, IsoInstant } from './models';
import {
  validateMemory,
  validateMilestone,
  validateProfile,
  type ReminderDraft,
  type ValidMemory,
  type ValidMilestone,
  type ValidProfile,
} from './validation';

/**
 * Restoring an export into an empty app (docs/ARCHITECTURE.md › Export and restore). The
 * document has passed `parseExportDocument`; this checks every record again with the
 * app's own validators, so a restored database holds nothing the editors couldn't save.
 */

/** Settings that belong to this phone, not to the data: never restored. */
export const DEVICE_ONLY_SETTINGS: readonly (keyof AppSettings)[] = [
  // Consent is asked on each device.
  'usageSharing',
  'usagePromptAnswered',
  // On a phone without a screen lock, a restored lock could never be opened.
  'appLock',
  'appLockAfter',
];

export interface RestoredMilestone {
  id: string;
  value: ValidMilestone;
  photo: string | null;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}

export interface RestoredMemory {
  id: string;
  value: ValidMemory;
  /** Archive paths of its photos, in order. */
  photos: string[];
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}

export interface RestorePlan {
  profile: ValidProfile;
  profilePhoto: string | null;
  profileCreatedAt: IsoInstant;
  milestones: RestoredMilestone[];
  memories: RestoredMemory[];
  settings: Partial<AppSettings>;
  /** Every archive path to read, each once. */
  photoPaths: string[];
  /** Photos the export itself said it couldn't include. */
  photosNotInExport: number;
}

export type RestorePlanResult =
  { ok: true; plan: RestorePlan } | { ok: false; reason: 'invalidContent' };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ARCHIVE_PHOTO = new RegExp(`^${EXPORT_MEDIA_DIR}/[A-Za-z0-9_-]{1,64}\\.jpg$`);
const MAX_RECORDS = 20_000;

export function planRestore(
  document: ExportDocument,
  today: Temporal.PlainDate,
): RestorePlanResult {
  const invalid = { ok: false, reason: 'invalidContent' } as const;
  const doc = document;
  if (!doc.profile) return invalid;
  if (doc.milestones.length + doc.memories.length + doc.reminderRules.length > MAX_RECORDS)
    return invalid;

  let photosNotInExport = 0;
  const photoPaths = new Set<string>();
  /** A valid archive path, null for none; undefined means the file is damaged. */
  const photo = (path: unknown): string | null | undefined => {
    if (path === null || path === undefined) return null;
    if (typeof path !== 'string' || !ARCHIVE_PHOTO.test(path)) return undefined;
    photoPaths.add(path);
    return path;
  };

  const profile = validateProfile(
    {
      displayName: str(doc.profile.displayName),
      selfName: str(doc.profile.selfName),
      relationshipLabel: str(doc.profile.relationshipLabel),
      startDate: String(doc.profile.startDate),
      startTime: str(doc.profile.startTime),
      startTimeZoneId: str(doc.profile.startTimeZoneId),
      calendarTimeZoneId: String(doc.profile.calendarTimeZoneId),
    },
    today,
  );
  const profilePhoto = photo(doc.profile.photoArchivePath);
  if (!profile.ok || profilePhoto === undefined) return invalid;

  const ids = new Set<string>();
  const freshId = (id: unknown): id is string =>
    typeof id === 'string' && ID.test(id) && !ids.has(id) && !!ids.add(id);

  const rulesByMilestone = new Map<string, ReminderDraft[]>();
  for (const rule of doc.reminderRules) {
    if (!rule.isEnabled) continue;
    const list = rulesByMilestone.get(rule.milestoneId) ?? [];
    list.push({
      offsetDays: rule.offsetDays,
      localTime: rule.localTime,
      includeEventTitle: rule.includeEventTitle === true,
    });
    rulesByMilestone.set(rule.milestoneId, list);
  }

  const milestones: RestoredMilestone[] = [];
  for (const m of doc.milestones) {
    if (!freshId(m.id)) return invalid;
    const reminders = rulesByMilestone.get(m.id) ?? [];
    const value = validateMilestone({
      title: String(m.title),
      category: String(m.category),
      eventDate: String(m.eventDate),
      eventTime: str(m.eventTime),
      recurrence: m.recurrence === 'yearly' ? 'yearly' : 'none',
      leapDayPolicy:
        m.leapDayPolicy === 'feb28' || m.leapDayPolicy === 'mar1' ? m.leapDayPolicy : null,
      note: str(m.note),
      isPinned: m.isPinned === true,
      remindersEnabled: reminders.length > 0,
      reminders,
    });
    const datePhoto = photo(m.photoArchivePath);
    if (!value.ok || datePhoto === undefined) return invalid;
    milestones.push({
      id: m.id,
      value: value.value,
      photo: datePhoto,
      createdAt: instant(m.createdAt),
      updatedAt: instant(m.updatedAt),
    });
  }
  const milestoneIds = new Set(milestones.map((m) => m.id));

  const memories: RestoredMemory[] = [];
  for (const m of doc.memories) {
    if (!freshId(m.id)) return invalid;
    const media = [...m.media].sort((a, b) => a.sortOrder - b.sortOrder);
    const photos: string[] = [];
    for (const item of media) {
      const path = photo(item.archivePath);
      if (path === undefined) return invalid;
      if (path === null) photosNotInExport++;
      else photos.push(path);
    }
    const value = validateMemory({
      title: str(m.title),
      body: str(m.body),
      memoryDate: String(m.memoryDate),
      // A link to a date that isn't in the export is dropped, not refused.
      milestoneId:
        typeof m.milestoneId === 'string' && milestoneIds.has(m.milestoneId) ? m.milestoneId : null,
      // The export may have lost a photo; the memory still comes back.
      photoCount: media.length,
    });
    if (!value.ok) return invalid;
    memories.push({
      id: m.id,
      value: value.value,
      photos,
      createdAt: instant(m.createdAt),
      updatedAt: instant(m.updatedAt),
    });
  }

  const settings: Partial<AppSettings> = { ...doc.settings };
  for (const key of DEVICE_ONLY_SETTINGS) delete settings[key];

  return {
    ok: true,
    plan: {
      profile: profile.value,
      profilePhoto,
      profileCreatedAt: instant(doc.profile.createdAt),
      milestones,
      memories,
      settings,
      photoPaths: [...photoPaths],
      photosNotInExport,
    },
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The recorded time when it is one, else the epoch (only used for ordering ties). */
function instant(value: unknown): IsoInstant {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)
    ? value
    : '1970-01-01T00:00:00Z';
}
