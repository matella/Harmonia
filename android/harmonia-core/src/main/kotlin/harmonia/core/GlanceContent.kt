package harmonia.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Per-widget/complication display choices. They can only make output more discreet. */
data class GlanceConfig(
    /** Null follows the app's widget counter setting. */
    val counterMode: CounterMode? = null,
    /** Allows the name and next date when the app-wide privacy mode permits them. */
    val showDetails: Boolean = true,
)

data class NextDate(val title: String?, val date: LocalDate, val daysUntil: Long)

/** Everything a widget, complication or watch screen renders — already privacy-filtered. */
sealed interface GlanceContent {
    /** No profile, deleted data, or unreadable snapshot: neutral brand placeholder. */
    data object Placeholder : GlanceContent

    data class Counter(
        val totalDays: Long,
        val calendar: CalendarDuration,
        val counterMode: CounterMode,
        val showBrand: Boolean,
        val name: String?,
        val next: NextDate?,
        val today: LocalDate,
    ) : GlanceContent
}

object Glance {
    /**
     * Resolves what to show *now*. The day count is recomputed from the stored start date
     * on every render, so a widget is correct whenever the OS redraws it, even if the
     * app has not run for weeks.
     */
    fun resolve(
        snapshot: WidgetSnapshot?,
        now: Instant,
        deviceZone: ZoneId,
        config: GlanceConfig = GlanceConfig(),
    ): GlanceContent {
        if (snapshot == null || !snapshot.ready || snapshot.startDate == null) return GlanceContent.Placeholder
        val zone = snapshot.calendarZone ?: deviceZone
        val today = now.atZone(zone).toLocalDate()
        if (today.isBefore(snapshot.startDate)) return GlanceContent.Placeholder

        val detailsAllowed = snapshot.privacy == PrivacyMode.NORMAL && config.showDetails
        val next = if (detailsAllowed) {
            snapshot.upcoming.firstOrNull { !it.date.isBefore(today) }?.let {
                NextDate(it.title, it.date, DateRules.totalDays(today, it.date))
            }
        } else {
            null
        }
        val mode = when {
            snapshot.privacy == PrivacyMode.MINIMAL -> CounterMode.DAYS
            else -> config.counterMode ?: snapshot.counterMode
        }
        return GlanceContent.Counter(
            totalDays = DateRules.totalDays(snapshot.startDate, today),
            calendar = DateRules.calendarDuration(snapshot.startDate, today),
            counterMode = mode,
            showBrand = snapshot.privacy != PrivacyMode.MINIMAL,
            name = if (detailsAllowed) snapshot.displayName else null,
            next = next,
            today = today,
        )
    }

    /** The next local midnight in the counter's zone — when the day count changes. */
    fun nextDayBoundary(snapshot: WidgetSnapshot?, now: Instant, deviceZone: ZoneId): Instant {
        val zone = snapshot?.calendarZone ?: deviceZone
        return now.atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant()
    }
}
