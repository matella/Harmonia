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

const RULES: Readonly<Partial<Record<SyncedRecordType, (p: Payload) => boolean>>> = {
  recovery: (p) => publicKey(p['public_key']),
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
    (p['start_time'] === null || p['start_time_zone_id'] !== null),
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
    (p['is_pinned'] === 0 || p['is_pinned'] === 1),
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
