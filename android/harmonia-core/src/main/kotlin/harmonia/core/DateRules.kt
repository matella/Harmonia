package harmonia.core

import java.time.LocalDate
import java.time.Year
import java.time.temporal.ChronoUnit

/** Years, months and remaining days of a calendar duration. */
data class CalendarDuration(val years: Int, val months: Int, val days: Int)

enum class LeapDayPolicy { FEB28, MAR1;

    companion object {
        fun parse(value: String?): LeapDayPolicy = if (value == "mar1") MAR1 else FEB28
    }
}

/**
 * Native port of the counter rules in src/app/core/domain (see docs/DATE_AND_TIME_RULES.md).
 * Kept deliberately small: widgets and complications only need day counts, the calendar
 * duration and the next annual occurrence.
 */
object DateRules {
    /**
     * Complete months M with start + M months <= end (month addition clamps to the end of
     * shorter months, as java.time.plusMonths does), split into years and months, plus the
     * remaining days. Months are always measured from the original start date.
     */
    fun calendarDuration(start: LocalDate, end: LocalDate): CalendarDuration {
        require(!end.isBefore(start)) { "end must not be before start" }
        var totalMonths = (end.year - start.year) * 12 + (end.monthValue - start.monthValue)
        var anchor = start.plusMonths(totalMonths.toLong())
        if (anchor.isAfter(end)) {
            totalMonths -= 1
            anchor = start.plusMonths(totalMonths.toLong())
        }
        return CalendarDuration(totalMonths / 12, totalMonths % 12, ChronoUnit.DAYS.between(anchor, end).toInt())
    }

    /** Whole calendar days from start (day 0) to end. */
    fun totalDays(start: LocalDate, end: LocalDate): Long = ChronoUnit.DAYS.between(start, end)

    fun annualDate(original: LocalDate, year: Int, policy: LeapDayPolicy): LocalDate {
        if (original.monthValue == 2 && original.dayOfMonth == 29 && !Year.isLeap(year.toLong())) {
            return if (policy == LeapDayPolicy.MAR1) LocalDate.of(year, 3, 1) else LocalDate.of(year, 2, 28)
        }
        return LocalDate.of(year, original.monthValue, original.dayOfMonth)
    }

    data class AnnualOccurrence(val date: LocalDate, val occurrenceNumber: Int, val daysUntil: Long)

    /** First occurrence on or after today; never before the original date. */
    fun nextAnnual(original: LocalDate, today: LocalDate, policy: LeapDayPolicy): AnnualOccurrence {
        if (!original.isBefore(today)) return AnnualOccurrence(original, 0, totalDays(today, original))
        var year = today.year
        var candidate = annualDate(original, year, policy)
        if (candidate.isBefore(today)) {
            year += 1
            candidate = annualDate(original, year, policy)
        }
        return AnnualOccurrence(candidate, year - original.year, totalDays(today, candidate))
    }
}
