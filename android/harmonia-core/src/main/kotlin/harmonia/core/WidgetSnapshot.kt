package harmonia.core

import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneId

enum class PrivacyMode { NORMAL, DISCREET, MINIMAL }
enum class CounterMode { DAYS, CALENDAR }

data class UpcomingEntry(val title: String?, val date: LocalDate)

/**
 * Versioned snapshot written by the app (docs/WIDGET_SNAPSHOT.md). Readers ignore unknown
 * fields and treat an unknown schema version or malformed payload as unavailable, which
 * falls back to the privacy-safe placeholder.
 */
data class WidgetSnapshot(
    val schemaVersion: Int,
    val ready: Boolean,
    val privacy: PrivacyMode,
    val counterMode: CounterMode,
    val startDate: LocalDate?,
    val calendarZone: ZoneId?,
    val displayName: String?,
    val upcoming: List<UpcomingEntry>,
    val generatedAt: String?,
) {
    companion object {
        const val SUPPORTED_SCHEMA_VERSION = 1

        fun parse(json: String?): WidgetSnapshot? {
            if (json.isNullOrBlank()) return null
            return try {
                val o = JSONObject(json)
                val version = o.optInt("schemaVersion", -1)
                if (version != SUPPORTED_SCHEMA_VERSION) return null
                val upcoming = mutableListOf<UpcomingEntry>()
                val list = o.optJSONArray("upcoming")
                if (list != null) {
                    for (i in 0 until list.length()) {
                        val entry = list.optJSONObject(i) ?: continue
                        val date = parseDate(entry.optStringOrNull("date")) ?: continue
                        upcoming += UpcomingEntry(entry.optStringOrNull("title"), date)
                    }
                }
                val startDate = parseDate(o.optStringOrNull("startDate"))
                WidgetSnapshot(
                    schemaVersion = version,
                    ready = o.optString("state") == "ready" && startDate != null,
                    privacy = when (o.optString("privacy")) {
                        "normal" -> PrivacyMode.NORMAL
                        "discreet" -> PrivacyMode.DISCREET
                        else -> PrivacyMode.MINIMAL
                    },
                    counterMode = if (o.optString("counterMode") == "calendar") CounterMode.CALENDAR else CounterMode.DAYS,
                    startDate = startDate,
                    calendarZone = o.optStringOrNull("calendarTimeZoneId")?.let { runCatching { ZoneId.of(it) }.getOrNull() },
                    displayName = o.optStringOrNull("displayName"),
                    upcoming = upcoming.sortedBy { it.date },
                    generatedAt = o.optStringOrNull("generatedAt"),
                )
            } catch (_: Exception) {
                null
            }
        }

        private fun parseDate(value: String?): LocalDate? = value?.let { runCatching { LocalDate.parse(it) }.getOrNull() }

        private fun JSONObject.optStringOrNull(key: String): String? =
            if (isNull(key) || !has(key)) null else optString(key).takeIf { it.isNotEmpty() }
    }
}
