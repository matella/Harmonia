import Foundation

public enum PrivacyMode: String, Sendable { case normal, discreet, minimal }
public enum CounterMode: String, Sendable { case days, calendar }

public struct UpcomingEntry: Equatable, Sendable {
    public let title: String?
    public let date: LocalDate
}

/// Versioned snapshot written by the app (docs/WIDGET_SNAPSHOT.md). Unknown fields are
/// ignored; an unknown schema version or malformed payload yields nil (placeholder).
public struct WidgetSnapshot: Equatable, Sendable {
    public static let supportedSchemaVersion = 1
    /// App Group shared by the app and its widget extension (and, on the watch, by the
    /// watch app and its complications).
    public static let appGroup = "group.harmonia.companion"
    public static let defaultsKey = "snapshot"

    public let ready: Bool
    public let privacy: PrivacyMode
    public let counterMode: CounterMode
    public let startDate: LocalDate?
    public let calendarZone: TimeZone?
    public let displayName: String?
    public let upcoming: [UpcomingEntry]
    public let generatedAt: String?

    private struct Wire: Decodable {
        let schemaVersion: Int
        let generatedAt: String?
        let state: String?
        let privacy: String?
        let counterMode: String?
        let startDate: String?
        let calendarTimeZoneId: String?
        let displayName: String?
        let upcoming: [WireUpcoming]?
    }

    private struct WireUpcoming: Decodable {
        let title: String?
        let date: String
    }

    public static func parse(_ json: String?) -> WidgetSnapshot? {
        guard let data = json?.data(using: .utf8),
              let wire = try? JSONDecoder().decode(Wire.self, from: data),
              wire.schemaVersion == supportedSchemaVersion else { return nil }
        let start = wire.startDate.flatMap(LocalDate.init(iso:))
        return WidgetSnapshot(
            ready: wire.state == "ready" && start != nil,
            privacy: PrivacyMode(rawValue: wire.privacy ?? "") ?? .minimal,
            counterMode: CounterMode(rawValue: wire.counterMode ?? "") ?? .days,
            startDate: start,
            calendarZone: wire.calendarTimeZoneId.flatMap(TimeZone.init(identifier:)),
            displayName: wire.displayName,
            upcoming: (wire.upcoming ?? [])
                .compactMap { u in LocalDate(iso: u.date).map { UpcomingEntry(title: u.title, date: $0) } }
                .sorted { $0.date < $1.date },
            generatedAt: wire.generatedAt
        )
    }

    /// Reads the snapshot stored in the shared App Group container.
    public static func load(defaults: UserDefaults? = UserDefaults(suiteName: appGroup)) -> WidgetSnapshot? {
        parse(defaults?.string(forKey: defaultsKey))
    }

    public static func store(_ json: String, defaults: UserDefaults? = UserDefaults(suiteName: appGroup)) {
        defaults?.set(json, forKey: defaultsKey)
    }
}
