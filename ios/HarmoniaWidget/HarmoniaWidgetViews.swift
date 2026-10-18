import HarmoniaCore
import SwiftUI
import UIKit
import WidgetKit

/// Harmonia tokens for WidgetKit (light/dark). Keep in sync with src/theme/_tokens.scss.
enum HarmoniaPalette {
    static let surface = dynamic(light: 0xFFFCF8, dark: 0x242023)
    static let ink = dynamic(light: 0x2B2024, dark: 0xF5EEEC)
    static let inkMuted = dynamic(light: 0x76676B, dark: 0xC0B0B3)
    static let berry = dynamic(light: 0x6D243B, dark: 0xD18A9A)
    static let rose = dynamic(light: 0xC26A77, dark: 0xE0A1AC)
    static let line = dynamic(light: 0xE3D8D3, dark: 0x44383E)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}

/// The two-ring Harmonia mark drawn natively.
struct HarmoniaMark: View {
    var size: CGFloat = 18

    var body: some View {
        let r = size * 11 / 48
        let offset = size * 5 / 48
        ZStack {
            Circle().stroke(HarmoniaPalette.berry, lineWidth: size * 2.4 / 48).frame(width: r * 2, height: r * 2).offset(x: -offset)
            Circle().stroke(HarmoniaPalette.rose, lineWidth: size * 2.4 / 48).frame(width: r * 2, height: r * 2).offset(x: offset)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Localized formatting shared by the widget layouts.
enum WidgetText {
    static func days(_ count: Int) -> String {
        count.formatted(.number)
    }

    static func daysTogether(_ count: Int) -> String {
        String(localized: "\(count) days together", comment: "Widget: total days, pluralized via String Catalog")
    }

    static func shortDuration(_ d: CalendarDuration) -> String {
        var parts: [String] = []
        if d.years > 0 { parts.append(String(localized: "\(d.years) years")) }
        if d.months > 0 { parts.append(String(localized: "\(d.months) months")) }
        if parts.isEmpty { parts.append(String(localized: "\(d.days) days")) }
        return parts.formatted(.list(type: .and, width: .narrow))
    }

    static func monthDay(_ date: LocalDate) -> String {
        var components = DateComponents()
        components.year = date.year
        components.month = date.month
        components.day = date.day
        components.hour = 12
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        guard let value = calendar.date(from: components) else { return date.description }
        // Format in UTC (where the noon instant was built) so the calendar day never shifts.
        var style = Date.FormatStyle().day().month(.wide)
        style.timeZone = calendar.timeZone
        return value.formatted(style)
    }

    static func inDays(_ count: Int) -> String {
        count == 0 ? String(localized: "Today") : String(localized: "in \(count) days")
    }
}

struct HarmoniaWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: HarmoniaEntry

    var body: some View {
        switch entry.content {
        case .placeholder:
            PlaceholderView()
                .widgetURL(URL(string: "harmonia://home"))
        case let .counter(c):
            Group {
                if family == .systemMedium { MediumView(c: c) } else { SmallView(c: c) }
            }
            .widgetURL(URL(string: "harmonia://home"))
        }
    }
}

private struct PlaceholderView: View {
    var body: some View {
        VStack(alignment: .leading) {
            HarmoniaMark(size: 22)
            Spacer()
            Text("Open Harmonia to begin")
                .font(.caption)
                .foregroundStyle(HarmoniaPalette.inkMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct CounterLines: View {
    let c: CounterContent

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if c.counterMode == .calendar && c.totalDays > 0 {
                Text(WidgetText.shortDuration(c.calendar))
                    .font(.system(.title2, design: .serif))
                    .foregroundStyle(HarmoniaPalette.berry)
                    .minimumScaleFactor(0.6)
                    .lineLimit(2)
                Text(WidgetText.daysTogether(c.totalDays))
                    .font(.caption)
                    .foregroundStyle(HarmoniaPalette.inkMuted)
            } else {
                Text(WidgetText.days(c.totalDays))
                    .font(.system(size: 40, weight: .regular, design: .serif))
                    .monospacedDigit()
                    .foregroundStyle(HarmoniaPalette.berry)
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                Text(c.totalDays == 1 ? String(localized: "day") : String(localized: "days"))
                    .font(.caption)
                    .foregroundStyle(HarmoniaPalette.inkMuted)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(WidgetText.daysTogether(c.totalDays))
    }
}

private struct SmallView: View {
    let c: CounterContent

    var body: some View {
        VStack(alignment: .leading) {
            if c.showBrand { HarmoniaMark(size: 22) }
            Spacer(minLength: 4)
            CounterLines(c: c)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct MediumView: View {
    let c: CounterContent

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if c.showBrand { HarmoniaMark(size: 18) }
                    if let name = c.name {
                        Text("You and \(name)").font(.system(.footnote, design: .serif)).foregroundStyle(HarmoniaPalette.inkMuted)
                    } else if c.showBrand {
                        Text("Harmonia").font(.system(.footnote, design: .serif)).foregroundStyle(HarmoniaPalette.inkMuted)
                    }
                }
                Spacer(minLength: 2)
                CounterLines(c: c)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let next = c.next {
                Rectangle().fill(HarmoniaPalette.line).frame(width: 1).padding(.vertical, 6)
                Link(destination: URL(string: "harmonia://dates")!) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(next.title ?? String(localized: "Next date"))
                            .font(.caption)
                            .foregroundStyle(HarmoniaPalette.inkMuted)
                            .lineLimit(1)
                        Text(WidgetText.monthDay(next.date))
                            .font(.system(.headline, design: .serif))
                            .foregroundStyle(HarmoniaPalette.ink)
                            .lineLimit(1)
                        Text(WidgetText.inDays(next.daysUntil))
                            .font(.caption)
                            .foregroundStyle(HarmoniaPalette.berry)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

/// Lock Screen accessory families (rendered in the system's vibrant/tinted style).
struct HarmoniaAccessoryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: HarmoniaEntry

    var body: some View {
        switch (family, entry.content) {
        case (.accessoryCircular, .counter(let c)):
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text(WidgetText.days(c.totalDays)).font(.system(.title3, design: .serif)).minimumScaleFactor(0.5).monospacedDigit()
                    Text(c.totalDays == 1 ? String(localized: "day") : String(localized: "days")).font(.caption2)
                }
            }
            .widgetURL(URL(string: "harmonia://home"))
            .accessibilityLabel(WidgetText.daysTogether(c.totalDays))
        case (.accessoryRectangular, .counter(let c)):
            VStack(alignment: .leading, spacing: 1) {
                Text(WidgetText.shortDuration(c.calendar)).font(.system(.headline, design: .serif)).widgetAccentable()
                Text(WidgetText.daysTogether(c.totalDays)).font(.caption)
                if let next = c.next {
                    Text("\(next.title ?? String(localized: "Next date")), \(WidgetText.inDays(next.daysUntil))").font(.caption2).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(URL(string: "harmonia://home"))
        case (.accessoryInline, .counter(let c)):
            Text(WidgetText.daysTogether(c.totalDays))
        case (.accessoryInline, .placeholder):
            Text("Harmonia")
        default:
            // No data (or deleted data): a neutral mark, never stale personal details.
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "circle.circle").font(.title3)
            }
            .accessibilityLabel("Harmonia")
        }
    }
}
