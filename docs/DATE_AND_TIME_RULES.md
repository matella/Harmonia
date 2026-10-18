# Date and time rules

Date correctness outranks everything else in Harmonia (spec §1.4, §8). This document is the contract for the TypeScript domain module (`src/app/core/domain`) and its native equivalents (`android/harmonia-core`, `ios/Shared/HarmoniaCore`). The canonical examples live in [`shared/test-vectors/date-vectors.json`](../shared/test-vectors/date-vectors.json) and are executed by every implementation's tests.

## Library

- **Temporal** via [`temporal-polyfill`](https://www.npmjs.com/package/temporal-polyfill) 1.0.x (full TC39 Temporal API, maintained, ~20 kB gzipped). Imported explicitly through `core/domain/temporal.ts` rather than installed as a global, so behaviour is identical in every WebView and in Node tests even where native Temporal exists.
- Native surfaces use the platform standard: `java.time` (Kotlin, with core-library desugaring on API < 26) and `Foundation.Calendar` (Swift). Both clamp month arithmetic the same way Temporal's `overflow: 'constrain'` does.
- "Now" always comes from an injected `Clock` (`core/domain/clock.ts`). Nothing in the domain reads the system clock directly, so every rule is testable with a fixed instant and zone.

## Stored semantics

| Value | Type | Example | Notes |
|---|---|---|---|
| `startDate`, `eventDate`, `memoryDate` | ISO local date `YYYY-MM-DD` | `2024-06-14` | Never converted to an instant. Serialized and parsed as text, so it cannot shift by a day. |
| `startTime`, `eventTime`, reminder `localTime` | Local wall-clock `HH:mm` | `20:15` | Optional except for reminders (default `09:00`). |
| `startTimeZoneId` | IANA zone | `Europe/Brussels` | Stored only when `startTime` is present; with the date and time it defines the historical start **instant**. |
| `calendarTimeZoneId` | IANA zone | `Europe/Brussels` | Zone in which "today" is evaluated for the counter. Initialized from the device at onboarding; only changes when the user changes it in Settings. |
| `createdAt`/`updatedAt` | ISO instant (UTC) | `2026-10-18T10:00:00Z` | Bookkeeping only. |
| `eventTimeZoneId` | IANA zone or null | `null` | Reserved. v1 milestones are *floating local*: they happen on their calendar date/wall-clock time wherever the device is. |

## Counter

- The start date is **day 0**. Total days = `startDate.until(today)` in whole calendar days, where `today` is the current date in `calendarTimeZoneId`.
- Nothing is stored or incremented: every value is recomputed from the profile and the clock (`computeRelationshipCounter`). The app refreshes the visible value on resume and at minute boundaries while in the foreground.
- **Calendar duration** (years, months, days), `calendarDurationBetween(start, end)`:
  1. `M` = number of complete months such that `start + M months ≤ end`. Month addition clamps to the last valid day of a shorter month (Temporal `constrain`, `java.time.plusMonths`, `Calendar.date(byAdding:)`).
  2. `years = floor(M / 12)`, `months = M mod 12`.
  3. `days = end − (start + M months)`.

  Months are measured from the **original start date** (the "anchor"), not from the year-adjusted date. This is equivalent to spec §8.3's years → months → days order for every start date except clamped ones (the 29th–31st and Feb 29), where it avoids impossible results such as "3 years, 12 months" for a Feb 29 start on 28 Feb 2028. Consequences:
  - A Jan 31 start has monthiversaries on Feb 28/29, Mar 31, Apr 30, …
  - A Feb 29 start celebrates its yearly anniversary on Feb 28 in common years; on 28 Mar 2025 it reads "1 year, 28 days" and becomes "1 year, 1 month" on 29 Mar.
- **Weeks and days**: `floor(totalDays / 7)` weeks and the remainder.
- **Precise duration**: only when the user entered a start time. The start instant is resolved once from (`startDate`, `startTime`, `startTimeZoneId`) and never re-interpreted, so travelling or DST changes cannot move it. Displayed as whole 24-hour days, hours, minutes and (on the counter detail screen only) seconds of elapsed time. A date-only profile never shows hours/minutes/seconds.
- **Future start date**: rejected by validation (`futureDate`). If persisted data ever contains one, the counter reports `not-started` with days until the start instead of a negative duration. A planned-relationship countdown mode is not implemented in v1.

## Recurrence and leap days

- Recurrence is `none` or `yearly`.
- `nextOccurrence(milestone, today)` returns the first occurrence on or after today. A yearly milestone never occurs before its original date (a future first occurrence is returned as-is). A past one-off returns null and appears under "Past".
- **Feb 29 policy** (app setting, overridable per milestone): in common years a Feb 29 milestone is celebrated on **Feb 28 (default)** or **Mar 1**. The same function (`annualDateInYear`) is used for upcoming lists, countdowns, reminders and widget snapshots, so the policy is applied consistently. 2100 is correctly treated as a common year.
- Ordering of occurrences on the same date is deterministic: untimed before timed, then time, then title (locale-aware, case-insensitive), then `createdAt`, then `id`.

## Time zones and DST

- Reminders fire at their local wall-clock time **in the device's current zone**. Plans are recomputed on launch, resume and time-zone change, so after travelling a 09:00 reminder fires at 09:00 local time.
- DST policy (`resolveLocalDateTime`, Temporal `disambiguation: 'compatible'`):
  - **Spring-forward gap**: a non-existent time moves forward by the length of the gap (02:30 → 03:30 on a 1-hour jump). This is the documented "next valid local time" choice; it matches `java.time.ZonedDateTime.of` and Foundation, so native code agrees.
  - **Fall-back overlap**: an ambiguous time resolves to the **first** (earlier) occurrence.
- On a time-zone change the app refreshes the display and reconciles reminders; it never rewrites stored dates.

## Examples (from the shared vectors)

| Start | End (today) | Result | Total days |
|---|---|---|---|
| 2024-06-14 | 2024-06-14 | 0 days (day 0) | 0 |
| 2023-01-31 | 2023-02-28 | 1 month | 28 |
| 2023-01-31 | 2023-03-01 | 1 month, 1 day | 29 |
| 2023-01-31 | 2023-03-30 | 1 month, 30 days | 58 |
| 2023-06-15 | 2024-06-14 | 11 months, 30 days | 365 |
| 2024-02-29 | 2025-02-28 | 1 year | 365 |
| 2024-02-29 | 2025-03-28 | 1 year, 28 days | 393 |
| 2024-02-29 | 2028-02-28 | 3 years, 11 months, 30 days | 1460 |

| Yearly event | Today | Policy | Next |
|---|---|---|---|
| 2024-02-29 | 2026-01-10 | feb28 | 2026-02-28 |
| 2024-02-29 | 2026-01-10 | mar1 | 2026-03-01 |
| 2020-06-14 | 2026-06-15 | — | 2027-06-14 |

DST examples (tests in `local-date.test.ts`, `relationship-duration.test.ts`, `reminder-planner.test.ts`):
- Europe/Brussels, 2026-03-29 02:30 → 03:30 CEST (`2026-03-29T01:30:00Z`).
- Europe/Brussels, 2026-10-25 02:30 → first occurrence, CEST (`2026-10-25T00:30:00Z`).
- America/New_York, start 2024-03-09 23:00 → exactly 23 hours elapsed at 2024-03-10 23:00 (1 calendar day).

## Test matrix (spec §8.7) → tests

| Requirement | Where |
|---|---|
| Same day = 0; +1 day; month/year boundaries; leap transitions; Feb 29 start | vectors `calendarDuration` (TS, Kotlin, Swift) |
| Feb 29 yearly milestone in common year, both policies | vectors `annualOccurrence`; `milestone-occurrence.test.ts`; `reminder-planner.test.ts` |
| DST spring-forward / fall-back | `local-date.test.ts`, `relationship-duration.test.ts`, `reminder-planner.test.ts` |
| Time-zone change keeps the historical start instant | `relationship-duration.test.ts` |
| Date-only values round-trip without shifting | `local-date.test.ts`, `persistence.test.ts` |
| Exact elapsed duration with a start time; none for date-only | `relationship-duration.test.ts` |
| Deterministic ordering of same-date milestones | `milestone-occurrence.test.ts` |
| Edit across time zones does not duplicate notifications | `reminder-planner.test.ts` (reconcile) |
| Passed yearly occurrence selects next year | vectors + `reminder-planner.test.ts` |
