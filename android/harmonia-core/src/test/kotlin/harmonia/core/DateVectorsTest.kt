package harmonia.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.time.LocalDate

/** Runs the canonical shared/test-vectors/date-vectors.json against the Kotlin port. */
class DateVectorsTest {
    private val vectors = JSONObject(File(System.getProperty("harmonia.vectors")).readText())

    @Test
    fun calendarDurationMatchesSharedVectors() {
        val cases = vectors.getJSONArray("calendarDuration")
        for (i in 0 until cases.length()) {
            val v = cases.getJSONObject(i)
            val start = LocalDate.parse(v.getString("start"))
            val end = LocalDate.parse(v.getString("end"))
            val name = v.getString("name")
            assertEquals(name, CalendarDuration(v.getInt("years"), v.getInt("months"), v.getInt("days")), DateRules.calendarDuration(start, end))
            assertEquals(name, v.getLong("totalDays"), DateRules.totalDays(start, end))
        }
    }

    @Test
    fun annualOccurrenceMatchesSharedVectors() {
        val cases = vectors.getJSONArray("annualOccurrence")
        for (i in 0 until cases.length()) {
            val v = cases.getJSONObject(i)
            val result = DateRules.nextAnnual(
                LocalDate.parse(v.getString("eventDate")),
                LocalDate.parse(v.getString("today")),
                LeapDayPolicy.parse(v.getString("policy")),
            )
            val name = v.getString("name")
            assertEquals(name, LocalDate.parse(v.getString("next")), result.date)
            assertEquals(name, v.getLong("daysUntil"), result.daysUntil)
            assertEquals(name, v.getInt("occurrenceNumber"), result.occurrenceNumber)
        }
    }

    @Test
    fun neverReportsTwelveMonths() {
        val start = LocalDate.of(2024, 2, 29)
        var day = start
        while (!day.isAfter(LocalDate.of(2032, 3, 31))) {
            val d = DateRules.calendarDuration(start, day)
            assert(d.months < 12) { "12 months on $day" }
            day = day.plusDays(1)
        }
    }
}
