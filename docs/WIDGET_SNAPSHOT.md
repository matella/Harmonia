# Widget & watch snapshot contract (schema version 1)

The app writes one JSON document after every relevant change. Native widgets, complications and watch apps read **only** this document — never the database.

| Platform | Location |
|---|---|
| Android widgets | SharedPreferences `harmonia_widget`, key `snapshot` (app-private) |
| Wear OS | Data Layer DataItem path `/harmonia/snapshot`, key `json` → watch SharedPreferences `harmonia_watch` |
| iOS widgets | `UserDefaults(suiteName: "group.harmonia.companion")`, key `snapshot` |
| watchOS | `WCSession.updateApplicationContext(["snapshot": json])` → watch App Group defaults, key `snapshot` |

Producer: `buildWidgetSnapshot()` in `src/app/core/domain/widget-snapshot.ts`. Consumers: `harmonia.core.WidgetSnapshot` (Kotlin) and `HarmoniaCore.WidgetSnapshot` (Swift).

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-18T10:00:00Z",
  "state": "ready",
  "privacy": "normal",
  "counterMode": "days",
  "startDate": "2024-06-14",
  "calendarTimeZoneId": "Europe/Brussels",
  "displayName": "Sam",
  "upcoming": [
    { "title": "Concert", "date": "2026-11-02" },
    { "title": "Our anniversary", "date": "2027-06-14" }
  ],
  "appearance": "system",
  "accent": "berry"
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | Readers accept only versions they know; anything else → placeholder. Bump on breaking changes. |
| `state` | `ready` or `empty` (no profile / after delete-all). `empty` must render a neutral placeholder. |
| `privacy` | `normal` (name + next date allowed), `discreet` (count + brand mark only), `minimal` (count only). |
| `counterMode` | `days` or `calendar` (years + months). Forced to `days` in `minimal`. |
| `startDate`, `calendarTimeZoneId` | Used to **recompute** the day count at render time, so widgets stay correct without the app. |
| `displayName` | Only present in `normal`. |
| `upcoming` | Next occurrences (≤ 6, ≤ ~13 months ahead, includes the following year's occurrence of yearly dates). Empty unless `normal`. Readers pick the first date ≥ today. |
| `appearance`, `accent` | Hints only; native widgets follow the system light/dark appearance. |

**Never included:** notes, memories, photos or photo paths, record IDs, reminder settings.

Per-widget options (counter style, "show name and next date") are stored natively per widget instance and can only make output more discreet than `privacy`.

## Refresh behaviour (honest limits)

- The app writes the snapshot only when its content changes (fingerprint without `generatedAt`), then requests a reload (Android `updateAppWidget`, iOS `WidgetCenter.reloadAllTimelines()`), and pushes it to the watch.
- Android also re-renders after the counter's local midnight (inexact alarm — may arrive late), every 6 h (`updatePeriodMillis`), and on time/zone/locale changes and boot.
- iOS/watchOS timelines contain an entry for each of the next 7 local midnights; WidgetKit decides when to render and may delay reloads under its budget.
- Wear OS complications receive a 7-day timeline, so the watch face advances at midnight even when the phone is out of range.
- Nothing ticks per second outside the foreground app.
