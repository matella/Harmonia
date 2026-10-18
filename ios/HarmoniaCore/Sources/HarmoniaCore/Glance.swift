import Foundation

/// Per-widget configuration. It can only make output more discreet than the app setting.
public struct GlanceConfig: Sendable {
    public var counterMode: CounterMode?
    public var showDetails: Bool

    public init(counterMode: CounterMode? = nil, showDetails: Bool = true) {
        self.counterMode = counterMode
        self.showDetails = showDetails
    }
}

public struct NextDate: Equatable, Sendable {
    public let title: String?
    public let date: LocalDate
    public let daysUntil: Int
}

public struct CounterContent: Equatable, Sendable {
    public let totalDays: Int
    public let calendar: CalendarDuration
    public let counterMode: CounterMode
    public let showBrand: Bool
    public let name: String?
    public let next: NextDate?
    public let today: LocalDate
}

/// What a widget, complication or watch screen renders — already privacy-filtered.
public enum GlanceContent: Equatable, Sendable {
    case placeholder
    case counter(CounterContent)
}

public enum Glance {
    /// Recomputes the counter from the stored start date for the given moment.
    public static func resolve(
        _ snapshot: WidgetSnapshot?,
        at now: Date = Date(),
        deviceZone: TimeZone = .current,
        config: GlanceConfig = GlanceConfig()
    ) -> GlanceContent {
        guard let snapshot, snapshot.ready, let start = snapshot.startDate else { return .placeholder }
        let today = LocalDate.today(in: snapshot.calendarZone ?? deviceZone, at: now)
        guard !(today < start) else { return .placeholder }
        let detailsAllowed = snapshot.privacy == .normal && config.showDetails
        let next: NextDate? = detailsAllowed
            ? snapshot.upcoming.first { !($0.date < today) }.map {
                NextDate(title: $0.title, date: $0.date, daysUntil: today.days(until: $0.date))
            }
            : nil
        return .counter(CounterContent(
            totalDays: DateRules.totalDays(from: start, to: today),
            calendar: DateRules.calendarDuration(from: start, to: today),
            counterMode: snapshot.privacy == .minimal ? .days : (config.counterMode ?? snapshot.counterMode),
            showBrand: snapshot.privacy != .minimal,
            name: detailsAllowed ? snapshot.displayName : nil,
            next: next,
            today: today
        ))
    }

    /// Timeline dates: now plus the next `days` local midnights in the counter's zone.
    public static func timelineDates(for snapshot: WidgetSnapshot?, from now: Date = Date(), days: Int = 7, deviceZone: TimeZone = .current) -> [Date] {
        let zone = snapshot?.calendarZone ?? deviceZone
        var dates = [now]
        var cursor = now
        for _ in 0..<days {
            cursor = DateRules.nextDayBoundary(after: cursor, in: zone)
            dates.append(cursor)
        }
        return dates
    }
}
