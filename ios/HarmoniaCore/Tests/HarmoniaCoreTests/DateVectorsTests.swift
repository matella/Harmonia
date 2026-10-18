import Foundation
import XCTest
@testable import HarmoniaCore

/// Runs shared/test-vectors/date-vectors.json — the same vectors as the TypeScript and Kotlin tests.
final class DateVectorsTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Duration: Decodable {
            let name: String, start: String, end: String
            let years: Int, months: Int, days: Int, totalDays: Int
        }
        struct Annual: Decodable {
            let name: String, eventDate: String, today: String, policy: String
            let next: String, daysUntil: Int, occurrenceNumber: Int
        }
        let calendarDuration: [Duration]
        let annualOccurrence: [Annual]
    }

    private func loadVectors() throws -> Vectors {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // HarmoniaCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // HarmoniaCore
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("shared/test-vectors/date-vectors.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testCalendarDurationVectors() throws {
        for v in try loadVectors().calendarDuration {
            let start = try XCTUnwrap(LocalDate(iso: v.start))
            let end = try XCTUnwrap(LocalDate(iso: v.end))
            XCTAssertEqual(DateRules.calendarDuration(from: start, to: end), CalendarDuration(years: v.years, months: v.months, days: v.days), v.name)
            XCTAssertEqual(DateRules.totalDays(from: start, to: end), v.totalDays, v.name)
        }
    }

    func testAnnualOccurrenceVectors() throws {
        for v in try loadVectors().annualOccurrence {
            let result = DateRules.nextAnnual(
                try XCTUnwrap(LocalDate(iso: v.eventDate)),
                today: try XCTUnwrap(LocalDate(iso: v.today)),
                policy: LeapDayPolicy(rawValue: v.policy) ?? .feb28
            )
            XCTAssertEqual(result.date.description, v.next, v.name)
            XCTAssertEqual(result.daysUntil, v.daysUntil, v.name)
            XCTAssertEqual(result.occurrenceNumber, v.occurrenceNumber, v.name)
        }
    }

    func testRejectsImpossibleDates() {
        XCTAssertNil(LocalDate(iso: "2023-02-29"))
        XCTAssertNil(LocalDate(iso: "2024-04-31"))
        XCTAssertNotNil(LocalDate(iso: "2024-02-29"))
    }
}

final class GlanceTests: XCTestCase {
    private func snapshot(_ privacy: String, counterMode: String = "days") -> WidgetSnapshot? {
        let name = privacy == "normal" ? "\"Sam\"" : "null"
        let upcoming = privacy == "normal" ? #"[{"title":"Concert","date":"2026-11-02"},{"title":"Our anniversary","date":"2027-06-14"}]"# : "[]"
        return WidgetSnapshot.parse("""
        {"schemaVersion":1,"generatedAt":"2026-10-18T09:00:00Z","state":"ready","privacy":"\(privacy)",
         "counterMode":"\(counterMode)","startDate":"2024-06-14","calendarTimeZoneId":"Europe/Brussels",
         "displayName":\(name),"upcoming":\(upcoming),"appearance":"system","accent":"berry","future":{"x":1}}
        """)
    }

    private let now = ISO8601DateFormatter().date(from: "2026-10-18T10:00:00Z")!

    func testNormalModeShowsDetails() {
        guard case let .counter(c) = Glance.resolve(snapshot("normal"), at: now) else { return XCTFail("placeholder") }
        XCTAssertEqual(c.totalDays, 856)
        XCTAssertEqual(c.calendar, CalendarDuration(years: 2, months: 4, days: 4))
        XCTAssertEqual(c.name, "Sam")
        XCTAssertEqual(c.next?.title, "Concert")
        XCTAssertEqual(c.next?.daysUntil, 15)
    }

    func testDiscreetAndMinimalHideDetails() {
        guard case let .counter(d) = Glance.resolve(snapshot("discreet"), at: now) else { return XCTFail("placeholder") }
        XCTAssertNil(d.name)
        XCTAssertNil(d.next)
        guard case let .counter(m) = Glance.resolve(snapshot("minimal", counterMode: "calendar"), at: now) else { return XCTFail("placeholder") }
        XCTAssertEqual(m.counterMode, .days)
        XCTAssertFalse(m.showBrand)
    }

    func testPlaceholderForMissingOrUnknownSnapshots() {
        XCTAssertEqual(Glance.resolve(nil, at: now), .placeholder)
        XCTAssertNil(WidgetSnapshot.parse("{\"schemaVersion\":2}"))
        XCTAssertNil(WidgetSnapshot.parse("garbage"))
    }

    func testTimelineAdvancesAtLocalMidnight() {
        let dates = Glance.timelineDates(for: snapshot("discreet"), from: now, days: 2)
        XCTAssertEqual(dates.count, 3)
        XCTAssertEqual(ISO8601DateFormatter().string(from: dates[1]), "2026-10-18T22:00:00Z") // midnight CEST
    }
}
