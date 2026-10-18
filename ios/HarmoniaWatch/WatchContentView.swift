import HarmoniaCore
import SwiftUI

private let berry = Color(red: 0xD1 / 255, green: 0x8A / 255, blue: 0x9A / 255)
private let inkMuted = Color(red: 0xC0 / 255, green: 0xB0 / 255, blue: 0xB3 / 255)

/// Glanceable watch screen. Editing stays on the iPhone; Handoff offers to continue there.
struct WatchContentView: View {
    @ObservedObject var model: WatchModel

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Text("Harmonia")
                    .font(.system(.footnote, design: .serif))
                    .foregroundStyle(inkMuted)
                    .accessibilityAddTraits(.isHeader)
                switch model.content {
                case .placeholder:
                    Text("Open Harmonia on your iPhone to begin.")
                        .multilineTextAlignment(.center)
                case let .counter(c):
                    Text(duration(c.calendar, totalDays: c.totalDays))
                        .font(.system(.title3, design: .serif))
                        .foregroundStyle(berry)
                        .multilineTextAlignment(.center)
                    Text("\(c.totalDays) days together")
                        .font(.footnote)
                    if let next = c.next {
                        Text("\(next.title ?? String(localized: "Next date")), \(next.daysUntil == 0 ? String(localized: "Today") : String(localized: "in \(next.daysUntil) days"))")
                            .font(.footnote)
                            .foregroundStyle(inkMuted)
                            .multilineTextAlignment(.center)
                    }
                }
                Text("Edit dates in Harmonia on your iPhone.")
                    .font(.caption2)
                    .foregroundStyle(inkMuted)
                    .multilineTextAlignment(.center)
                    .padding(.top, 6)
            }
            .padding(.horizontal, 6)
        }
        // Handoff: the iPhone shows a Harmonia suggestion to continue there.
        .userActivity("harmonia.companion.open") { activity in
            activity.isEligibleForHandoff = true
            activity.title = "Harmonia"
        }
    }

    private func duration(_ d: CalendarDuration, totalDays: Int) -> String {
        if totalDays == 0 { return String(localized: "Your first day together") }
        var parts: [String] = []
        if d.years > 0 { parts.append(String(localized: "\(d.years) years")) }
        if d.months > 0 { parts.append(String(localized: "\(d.months) months")) }
        if d.days > 0 { parts.append(String(localized: "\(d.days) days")) }
        return parts.formatted(.list(type: .and, width: .narrow))
    }
}
