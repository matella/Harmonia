import { isValidIsoDate, isValidLocalTime, isValidTimeZoneId } from '../domain/local-date';
import { MILESTONE_CATEGORIES } from '../domain/models';
import type { SyncedRecordType } from '../domain/sync-schema';
import { Temporal } from '../domain/temporal';
import { LIMITS } from '../domain/validation';
import type { SqlValue } from '../persistence/sql-driver';

/**
 * Domain checks for records received from the space: the same rules the editors apply,
 * so a buggy or outdated partner app cannot store a value this app cannot show.
 * (The start date may be "in the future" here: the partner's today can be ahead of ours.)
 */
type Payload = Readonly<Record<string, SqlValue>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const optionalText = (value: SqlValue, max: number) =>
  value === null || (typeof value === 'string' && value.length <= max);
const optionalTime = (value: SqlValue) =>
  value === null || (typeof value === 'string' && isValidLocalTime(value));
const optionalZone = (value: SqlValue) =>
  value === null || (typeof value === 'string' && isValidTimeZoneId(value));
const isoDate = (value: SqlValue) => typeof value === 'string' && isValidIsoDate(value);

function optionalInstant(value: SqlValue): boolean {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  try {
    Temporal.Instant.from(value);
    return true;
  } catch {
    return false;
  }
}

/** A 32-byte public key in standard base64 (44 characters with padding). */
const publicKey = (value: SqlValue) =>
  typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value);

const optionalUuid = (value: SqlValue) =>
  value === null || (typeof value === 'string' && UUID.test(value));
/** Standard base64 of exactly `bytes` bytes. */
const base64Of = (value: SqlValue, bytes: number) =>
  typeof value === 'string' &&
  value.length === Math.ceil(bytes / 3) * 4 &&
  /^[A-Za-z0-9+/]*={0,2}$/.test(value);
/** A photo is at most a 2048 px JPEG; anything near this is not one of ours. */
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

/**
 * A photo's blob fields come all together or not at all (a photo not uploaded yet, or no
 * photo, has none; a record without them is still well-formed).
 */
function blobFields(p: Payload): boolean {
  return (
    (p['blob_id'] === null &&
      p['blob_key'] === null &&
      p['blob_header'] === null &&
      p['blob_size'] === null) ||
    (typeof p['blob_id'] === 'string' &&
      UUID.test(p['blob_id']) &&
      base64Of(p['blob_key'], 32) &&
      base64Of(p['blob_header'], 24) &&
      Number.isInteger(p['blob_size']) &&
      (p['blob_size'] as number) > 0 &&
      (p['blob_size'] as number) <= MAX_PHOTO_BYTES)
  );
}

const RULES: Readonly<Partial<Record<SyncedRecordType, (p: Payload) => boolean>>> = {
  // Only these can be deleted for good: a purge naming anything else is refused (§18).
  purge: (p) =>
    p['record_type'] === 'milestone' ||
    p['record_type'] === 'memory' ||
    p['record_type'] === 'memory_media',
  memory: (p) =>
    optionalUuid(p['milestone_id']) &&
    optionalText(p['title'], LIMITS.memoryTitle) &&
    optionalText(p['body'], LIMITS.memoryBody) &&
    isoDate(p['memory_date']) &&
    optionalUuid(p['trashed_with']),
  memory_media: (p) =>
    typeof p['memory_id'] === 'string' &&
    UUID.test(p['memory_id']) &&
    Number.isInteger(p['sort_order']) &&
    (p['sort_order'] as number) >= 0 &&
    blobFields(p),
  recovery: (p) => publicKey(p['public_key']),
  // "Thinking of you" (§22): just when it was sent.
  nudge: (p) => typeof p['sent_at'] === 'string' && optionalInstant(p['sent_at']),
  device: (p) =>
    (p['person_id'] === null ||
      (typeof p['person_id'] === 'string' && UUID.test(p['person_id']))) &&
    publicKey(p['sign_public_key']) &&
    publicKey(p['box_public_key']) &&
    (p['platform'] === 'android' || p['platform'] === 'ios') &&
    optionalInstant(p['revoked_at']),
  profile: (p) =>
    optionalText(p['relationship_label'], LIMITS.relationshipLabel) &&
    isoDate(p['start_date']) &&
    optionalTime(p['start_time']) &&
    optionalZone(p['start_time_zone_id']) &&
    (p['start_time'] === null || p['start_time_zone_id'] !== null) &&
    blobFields(p),
  person: (p) => optionalText(p['display_name'], LIMITS.displayName),
  milestone: (p) =>
    typeof p['title'] === 'string' &&
    p['title'].trim().length > 0 &&
    p['title'].length <= LIMITS.milestoneTitle &&
    typeof p['category'] === 'string' &&
    (MILESTONE_CATEGORIES as readonly string[]).includes(p['category']) &&
    isoDate(p['event_date']) &&
    optionalTime(p['event_time']) &&
    optionalZone(p['event_time_zone_id']) &&
    (p['recurrence_rule'] === 'none' || p['recurrence_rule'] === 'yearly') &&
    (p['leap_day_policy'] === null ||
      p['leap_day_policy'] === 'feb28' ||
      p['leap_day_policy'] === 'mar1') &&
    optionalText(p['note'], LIMITS.milestoneNote) &&
    (p['is_pinned'] === 0 || p['is_pinned'] === 1) &&
    blobFields(p),
};

/** True when the payload's values are acceptable for its type. Types without rules are refused. */
export function isAcceptablePayload(type: SyncedRecordType, payload: Payload): boolean {
  const rule = RULES[type];
  if (!rule) return false;
  if ('author_person_id' in payload) {
    const author = payload['author_person_id'];
    if (author !== null && (typeof author !== 'string' || !UUID.test(author))) return false;
  }
  if ('deleted_at' in payload && !optionalInstant(payload['deleted_at'])) return false;
  return rule(payload);
}
