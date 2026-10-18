import { todayIn, type IsoDate } from './local-date';
import { compareOccurrences, upcomingOccurrences, type Occurrence } from './milestone-occurrence';
import type { AccentPreset, AppSettings, IsoInstant, Milestone, RelationshipProfile, ThemePreference, WidgetPrivacyMode } from './models';
import type { Clock } from './clock';
import { togetherOptionsFrom, upcomingTogetherMarks, type TogetherMark } from './together-milestones';

/**
 * Versioned contract consumed by native widgets, complications and watch apps
 * (Android: SharedPreferences "harmonia_widget"/"snapshot"; iOS: App Group
 * UserDefaults "snapshot"). Documented in docs/WIDGET_SNAPSHOT.md. Native readers must
 * ignore unknown fields and treat an unknown schemaVersion as "unavailable".
 *
 * It intentionally contains no notes, photos, memories or record IDs.
 */
export const WIDGET_SNAPSHOT_SCHEMA_VERSION = 1;

/** Occurrences further away than this are not included. */
const UPCOMING_HORIZON_DAYS = 400;
const MAX_UPCOMING = 6;
/** Derived together milestones may take at most this many of the upcoming slots. */
const MAX_TOGETHER = 2;

export interface WidgetUpcomingEntry {
  /** Null unless privacy mode is "normal". */
  title: string | null;
  date: IsoDate;
}

export interface WidgetSnapshot {
  schemaVersion: typeof WIDGET_SNAPSHOT_SCHEMA_VERSION;
  generatedAt: IsoInstant;
  /** "empty" means no profile: widgets show a neutral placeholder. */
  state: 'ready' | 'empty';
  privacy: WidgetPrivacyMode;
  counterMode: 'days' | 'calendar';
  startDate: IsoDate | null;
  calendarTimeZoneId: string | null;
  /** Partner/display name; only in "normal" privacy mode. */
  displayName: string | null;
  /**
   * Next occurrences (sorted, up to ~13 months ahead) so a widget can roll over to
   * the following milestone without the app running. Empty unless privacy is "normal".
   */
  upcoming: WidgetUpcomingEntry[];
  appearance: ThemePreference;
  accent: AccentPreset;
}

export interface WidgetSnapshotInput {
  profile: RelationshipProfile | null;
  milestones: readonly Milestone[];
  settings: AppSettings;
  clock: Clock;
  /** Localized title of a together milestone ("6 months together"); omit to leave them out. */
  togetherTitle?: (mark: TogetherMark) => string;
}

/** The privacy-safe placeholder written when there is no profile or after deletion. */
export function emptyWidgetSnapshot(generatedAt: IsoInstant, settings?: Pick<AppSettings, 'theme' | 'accent'>): WidgetSnapshot {
  return {
    schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    state: 'empty',
    privacy: 'minimal',
    counterMode: 'days',
    startDate: null,
    calendarTimeZoneId: null,
    displayName: null,
    upcoming: [],
    appearance: settings?.theme ?? 'system',
    accent: settings?.accent ?? 'berry',
  };
}

export function buildWidgetSnapshot(input: WidgetSnapshotInput): WidgetSnapshot {
  const generatedAt = input.clock.now().toString();
  const { profile, settings } = input;
  if (!profile) return emptyWidgetSnapshot(generatedAt, settings);

  const privacy = settings.widgetPrivacy;
  let upcoming: WidgetUpcomingEntry[] = [];
  if (privacy === 'normal') {
    const today = todayIn(input.clock, profile.calendarTimeZoneId);
    const occurrences: Occurrence[] = input.milestones
      .flatMap((m) => upcomingOccurrences(m, today, settings.leapDayPolicy, 2))
      .filter((o) => o.daysFromToday <= UPCOMING_HORIZON_DAYS)
      .sort(compareOccurrences);
    const entries = occurrences.map((o) => ({ title: o.milestone.title, date: o.date.toString() }));
    if (input.togetherTitle) {
      const options = togetherOptionsFrom(settings, input.milestones, profile.startDate);
      const title = input.togetherTitle;
      const marks = upcomingTogetherMarks(profile.startDate, today, options, MAX_TOGETHER)
        .filter((m) => m.daysFromToday <= UPCOMING_HORIZON_DAYS)
        .map((m) => ({ title: title(m), date: m.date.toString() }));
      // At most MAX_TOGETHER derived entries, so the user's own dates keep most slots.
      entries.push(...marks);
      // Stable sort keeps the user's own date first when both fall on the same day.
      entries.sort((a, b) => a.date.localeCompare(b.date));
    }
    upcoming = entries.slice(0, MAX_UPCOMING);
  }

  return {
    schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    state: 'ready',
    privacy,
    counterMode: privacy === 'minimal' ? 'days' : settings.widgetCounterMode,
    startDate: profile.startDate,
    calendarTimeZoneId: profile.calendarTimeZoneId,
    displayName: privacy === 'normal' ? profile.displayName : null,
    upcoming,
    appearance: settings.theme,
    accent: settings.accent,
  };
}

/**
 * Content fingerprint excluding the timestamp, used to avoid redundant widget reload
 * requests (which count against OS refresh budgets).
 */
export function snapshotFingerprint(snapshot: WidgetSnapshot): string {
  const { generatedAt: _ignored, ...content } = snapshot;
  return JSON.stringify(content);
}
