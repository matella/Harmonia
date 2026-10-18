import Foundation

/// A calendar date without time or zone (`YYYY-MM-DD`). Never converted to an instant.
public struct LocalDate: Hashable, Comparable, Sendable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    public init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// Parses `YYYY-MM-DD`, rejecting impossible dates such as 2023-02-29.
    public init?(iso: String) {
        let parts = iso.split(separator: "-")
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) else { return nil }
        let candidate = LocalDate(year: y, month: m, day: d)
        guard let date = candidate.utcDate, LocalDate(utc: date) == candidate else { return nil }
        self = candidate
    }

    public var description: String { String(format: "%04d-%02d-%02d", year, month, day) }

    public static func < (a: LocalDate, b: LocalDate) -> Bool {
        (a.year, a.month, a.day) < (b.year, b.month, b.day)
    }

    /// Today in the given zone.
    public static func today(in zone: TimeZone, at now: Date = Date()) -> LocalDate {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let c = calendar.dateComponents([.year, .month, .day], from: now)
        return LocalDate(year: c.year!, month: c.month!, day: c.day!)
    }

    // Pure date arithmetic runs in UTC at noon, where no DST transition can interfere.
    static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    var utcDate: Date? {
        LocalDate.utc.date(from: DateComponents(year: year, month: month, day: day, hour: 12))
    }

    init(utc date: Date) {
        let c = LocalDate.utc.dateComponents([.year, .month, .day], from: date)
        self.init(year: c.year!, month: c.month!, day: c.day!)
    }

    /// Adds months, clamping to the last day of shorter months (Jan 31 + 1 month = Feb 28/29).
    public func addingMonths(_ months: Int) -> LocalDate {
        LocalDate(utc: LocalDate.utc.date(byAdding: .month, value: months, to: utcDate!)!)
    }

    public func addingDays(_ days: Int) -> LocalDate {
        LocalDate(utc: LocalDate.utc.date(byAdding: .day, value: days, to: utcDate!)!)
    }

    public func days(until other: LocalDate) -> Int {
        LocalDate.utc.dateComponents([.day], from: utcDate!, to: other.utcDate!).day!
    }
}

public struct CalendarDuration: Equatable, Sendable {
    public let years: Int
    public let months: Int
    public let days: Int

    public init(years: Int, months: Int, days: Int) {
        self.years = years
        self.months = months
        self.days = days
    }
}

public enum LeapDayPolicy: String, Sendable {
    case feb28
    case mar1
}

/// Swift port of src/app/core/domain date rules (docs/DATE_AND_TIME_RULES.md).
public enum DateRules {
    /// Complete months M with start + M months <= end, split into years/months, plus days.
    /// Months are measured from the original start date (never "12 months").
    public static func calendarDuration(from start: LocalDate, to end: LocalDate) -> CalendarDuration {
        precondition(!(end < start), "end must not be before start")
        var totalMonths = (end.year - start.year) * 12 + (end.month - start.month)
        var anchor = start.addingMonths(totalMonths)
        if end < anchor {
            totalMonths -= 1
            anchor = start.addingMonths(totalMonths)
        }
        return CalendarDuration(years: totalMonths / 12, months: totalMonths % 12, days: anchor.days(until: end))
    }

    public static func totalDays(from start: LocalDate, to end: LocalDate) -> Int {
        start.days(until: end)
    }

    public static func isLeap(_ year: Int) -> Bool {
        (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    }

    public static func annualDate(_ original: LocalDate, year: Int, policy: LeapDayPolicy) -> LocalDate {
        if original.month == 2, original.day == 29, !isLeap(year) {
            return policy == .mar1 ? LocalDate(year: year, month: 3, day: 1) : LocalDate(year: year, month: 2, day: 28)
        }
        return LocalDate(year: year, month: original.month, day: original.day)
    }

    public struct AnnualOccurrence: Equatable, Sendable {
        public let date: LocalDate
        public let occurrenceNumber: Int
        public let daysUntil: Int
    }

    public static func nextAnnual(_ original: LocalDate, today: LocalDate, policy: LeapDayPolicy) -> AnnualOccurrence {
        if !(original < today) {
            return AnnualOccurrence(date: original, occurrenceNumber: 0, daysUntil: today.days(until: original))
        }
        var year = today.year
        var candidate = annualDate(original, year: year, policy: policy)
        if candidate < today {
            year += 1
            candidate = annualDate(original, year: year, policy: policy)
        }
        return AnnualOccurrence(date: candidate, occurrenceNumber: year - original.year, daysUntil: today.days(until: candidate))
    }

    /// The next local midnight in `zone` after `now` — when the day count changes.
    public static func nextDayBoundary(after now: Date, in zone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let start = calendar.startOfDay(for: now)
        return calendar.date(byAdding: .day, value: 1, to: start)!
    }
}
