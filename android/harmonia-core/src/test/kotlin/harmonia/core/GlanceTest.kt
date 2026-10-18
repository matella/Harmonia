package harmonia.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class GlanceTest {
    private val brussels = ZoneId.of("Europe/Brussels")
    private val now = Instant.parse("2026-10-18T10:00:00Z")

    private fun snapshot(privacy: String, counterMode: String = "days", state: String = "ready", schema: Int = 1) = """
        {"schemaVersion":$schema,"generatedAt":"2026-10-18T09:00:00Z","state":"$state","privacy":"$privacy",
         "counterMode":"$counterMode","startDate":"2024-06-14","calendarTimeZoneId":"Europe/Brussels",
         "displayName":${if (privacy == "normal") "\"Sam\"" else "null"},
         "upcoming":${if (privacy == "normal") """[{"title":"Concert","date":"2026-11-02"},{"title":"Our anniversary","date":"2027-06-14"}]""" else "[]"},
         "appearance":"system","accent":"berry","futureField":{"ignored":true}}
    """.trimIndent()

    @Test
    fun normalModeShowsNameAndNextDate() {
        val content = Glance.resolve(WidgetSnapshot.parse(snapshot("normal")), now, brussels) as GlanceContent.Counter
        assertEquals(856L, content.totalDays)
        assertEquals(CalendarDuration(2, 4, 4), content.calendar)
        assertEquals("Sam", content.name)
        assertEquals(NextDate("Concert", LocalDate.of(2026, 11, 2), 15), content.next)
        assertTrue(content.showBrand)
    }

    @Test
    fun rollsOverToTheFollowingDateWithoutTheApp() {
        val later = Instant.parse("2026-11-03T10:00:00Z")
        val content = Glance.resolve(WidgetSnapshot.parse(snapshot("normal")), later, brussels) as GlanceContent.Counter
        assertEquals("Our anniversary", content.next?.title)
        assertEquals(872L, content.totalDays)
    }

    @Test
    fun discreetAndMinimalHideDetails() {
        val discreet = Glance.resolve(WidgetSnapshot.parse(snapshot("discreet")), now, brussels) as GlanceContent.Counter
        assertNull(discreet.name)
        assertNull(discreet.next)
        assertTrue(discreet.showBrand)
        val minimal = Glance.resolve(WidgetSnapshot.parse(snapshot("minimal", "calendar")), now, brussels) as GlanceContent.Counter
        assertEquals(CounterMode.DAYS, minimal.counterMode)
        assertTrue(!minimal.showBrand)
    }

    @Test
    fun perWidgetConfigCanOnlyBeMoreDiscreet() {
        val parsed = WidgetSnapshot.parse(snapshot("normal"))
        val hidden = Glance.resolve(parsed, now, brussels, GlanceConfig(showDetails = false)) as GlanceContent.Counter
        assertNull(hidden.name)
        val discreet = WidgetSnapshot.parse(snapshot("discreet"))
        val stillHidden = Glance.resolve(discreet, now, brussels, GlanceConfig(showDetails = true)) as GlanceContent.Counter
        assertNull(stillHidden.name)
    }

    @Test
    fun placeholderForMissingEmptyOrUnknownSnapshots() {
        assertEquals(GlanceContent.Placeholder, Glance.resolve(null, now, brussels))
        assertEquals(GlanceContent.Placeholder, Glance.resolve(WidgetSnapshot.parse("not json"), now, brussels))
        assertEquals(GlanceContent.Placeholder, Glance.resolve(WidgetSnapshot.parse(snapshot("normal", state = "empty")), now, brussels))
        assertNull(WidgetSnapshot.parse(snapshot("normal", schema = 2)))
    }

    @Test
    fun usesTheCalendarZoneNotTheDeviceZone() {
        // 23:30 UTC is already the next day in Brussels while New York is still on the 14th.
        val json = snapshot("discreet").replace("2024-06-14", "2026-10-18")
        val content = Glance.resolve(WidgetSnapshot.parse(json), Instant.parse("2026-10-18T23:30:00Z"), ZoneId.of("America/New_York"))
        assertEquals(1L, (content as GlanceContent.Counter).totalDays)
        assertEquals(
            Instant.parse("2026-10-19T22:00:00Z"),
            Glance.nextDayBoundary(WidgetSnapshot.parse(json), Instant.parse("2026-10-18T23:30:00Z"), ZoneId.of("America/New_York")),
        )
    }
}
