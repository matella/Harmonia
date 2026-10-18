import AppIntents
import HarmoniaCore
import SwiftUI
import WidgetKit

// MARK: - Configuration (App Intents, iOS 17+)

enum CounterChoice: String, AppEnum {
    case app
    case days
    case calendar

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Counter"
    static let caseDisplayRepresentations: [CounterChoice: DisplayRepresentation] = [
        .app: "Use the app setting",
        .days: "Total days",
        .calendar: "Years and months",
    ]

    var mode: CounterMode? {
        switch self {
        case .app: return nil
        case .days: return .days
        case .calendar: return .calendar
        }
    }
}

struct HarmoniaWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Harmonia"
    static let description = IntentDescription("Choose how your time together is shown.")

    @Parameter(title: "Counter", default: .app)
    var counter: CounterChoice

    /// Only takes effect when Harmonia's widget privacy is set to “Everything”.
    @Parameter(title: "Show name and next date", default: true)
    var showDetails: Bool
}

// MARK: - Timeline

struct HarmoniaEntry: TimelineEntry {
    let date: Date
    let content: GlanceContent
}

/// Builds one entry now and one at each of the next seven local midnights, computed from
/// the stored start date — so the count is right even if WidgetKit reloads late.
struct HarmoniaProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> HarmoniaEntry {
        HarmoniaEntry(date: .now, content: .placeholder)
    }

    func snapshot(for configuration: HarmoniaWidgetIntent, in context: Context) async -> HarmoniaEntry {
        entry(at: .now, configuration: configuration, snapshot: WidgetSnapshot.load())
    }

    func timeline(for configuration: HarmoniaWidgetIntent, in context: Context) async -> Timeline<HarmoniaEntry> {
        let snapshot = WidgetSnapshot.load()
        let dates = Glance.timelineDates(for: snapshot, days: 7)
        let entries = dates.map { entry(at: $0, configuration: configuration, snapshot: snapshot) }
        return Timeline(entries: entries, policy: .after(dates.last ?? .now.addingTimeInterval(86_400)))
    }

    private func entry(at date: Date, configuration: HarmoniaWidgetIntent, snapshot: WidgetSnapshot?) -> HarmoniaEntry {
        let config = GlanceConfig(counterMode: configuration.counter.mode, showDetails: configuration.showDetails)
        return HarmoniaEntry(date: date, content: Glance.resolve(snapshot, at: date, config: config))
    }
}

// MARK: - Widgets

struct HarmoniaHomeWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "HarmoniaHomeWidget", intent: HarmoniaWidgetIntent.self, provider: HarmoniaProvider()) { entry in
            HarmoniaWidgetView(entry: entry)
                .containerBackground(for: .widget) { HarmoniaPalette.surface }
        }
        .configurationDisplayName("Harmonia")
        .description("Your time together and the next date that matters.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct HarmoniaLockScreenWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "HarmoniaLockScreenWidget", intent: HarmoniaWidgetIntent.self, provider: HarmoniaProvider()) { entry in
            HarmoniaAccessoryView(entry: entry)
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Days together")
        .description("A quiet day count for your Lock Screen.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

@main
struct HarmoniaWidgetBundle: WidgetBundle {
    var body: some Widget {
        HarmoniaHomeWidget()
        HarmoniaLockScreenWidget()
    }
}
