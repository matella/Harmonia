import HarmoniaCore
import SwiftUI
import WidgetKit

/// watchOS complications and Smart Stack widget (WidgetKit, watchOS 10+).
/// Reads the snapshot cached by the watch app; one timeline entry per local day.
struct ComplicationEntry: TimelineEntry {
    let date: Date
    let content: GlanceContent
}

struct ComplicationProvider: TimelineProvider {
    func placeholder(in context: Context) -> ComplicationEntry {
        ComplicationEntry(date: .now, content: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (ComplicationEntry) -> Void) {
        completion(ComplicationEntry(date: .now, content: Glance.resolve(WidgetSnapshot.load())))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ComplicationEntry>) -> Void) {
        let snapshot = WidgetSnapshot.load()
        let dates = Glance.timelineDates(for: snapshot, days: 7)
        let entries = dates.map { ComplicationEntry(date: $0, content: Glance.resolve(snapshot, at: $0)) }
        completion(Timeline(entries: entries, policy: .after(dates.last ?? .now.addingTimeInterval(86_400))))
    }
}

struct ComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ComplicationEntry

    var body: some View {
        switch (family, entry.content) {
        case (.accessoryCircular, .counter(let c)):
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text(c.totalDays.formatted()).font(.system(.title3, design: .serif)).minimumScaleFactor(0.4).monospacedDigit()
                    Text(c.totalDays == 1 ? String(localized: "day") : String(localized: "days")).font(.system(size: 9))
                }
            }
            .accessibilityLabel(Text("\(c.totalDays) days together"))
        case (.accessoryCorner, .counter(let c)):
            Text(c.totalDays.formatted())
                .font(.system(.title3, design: .serif))
                .widgetLabel { Text("\(c.totalDays) days together") }
        case (.accessoryRectangular, .counter(let c)):
            VStack(alignment: .leading, spacing: 1) {
                Text("Harmonia").font(.system(.caption2, design: .serif)).foregroundStyle(.secondary)
                Text("\(c.totalDays) days together").font(.system(.headline, design: .serif)).widgetAccentable()
                if let next = c.next {
                    Text("\(next.title ?? String(localized: "Next date")), \(next.daysUntil == 0 ? String(localized: "Today") : String(localized: "in \(next.daysUntil) days"))")
                        .font(.caption2)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case (.accessoryInline, .counter(let c)):
            Text("\(c.totalDays) days together")
        default:
            // Missing/stale/deleted data: fall back to a small app identifier.
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "circle.circle")
            }
            .accessibilityLabel(Text("Harmonia"))
        }
    }
}

@main
struct HarmoniaComplications: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HarmoniaComplication", provider: ComplicationProvider()) { entry in
            ComplicationView(entry: entry)
                .containerBackground(for: .widget) { Color.clear }
                .widgetURL(URL(string: "harmonia://home"))
        }
        .configurationDisplayName("Days together")
        .description("Your day count, quietly.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
    }
}
