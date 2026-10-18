import HarmoniaCore
import SwiftUI
import WatchConnectivity
import WatchKit
import WidgetKit

@main
struct HarmoniaWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = WatchModel()

    var body: some Scene {
        WindowGroup {
            WatchContentView(model: model)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { model.reload() }
                }
        }
    }
}

final class WatchAppDelegate: NSObject, WKApplicationDelegate {
    func applicationDidFinishLaunching() {
        WatchSessionReceiver.shared.activate()
    }
}

/// Recomputes what to show from the cached snapshot whenever the app becomes active.
final class WatchModel: ObservableObject {
    @Published private(set) var content: GlanceContent = .placeholder

    init() {
        reload()
        NotificationCenter.default.addObserver(forName: WatchSessionReceiver.didUpdate, object: nil, queue: .main) { [weak self] _ in
            self?.reload()
        }
    }

    func reload() {
        content = Glance.resolve(WidgetSnapshot.load())
    }
}

/// Receives the snapshot from the iPhone (WatchConnectivity application context) and
/// caches it in the watch's App Group so the complications can read it.
final class WatchSessionReceiver: NSObject, WCSessionDelegate {
    static let shared = WatchSessionReceiver()
    static let didUpdate = Notification.Name("HarmoniaSnapshotDidUpdate")

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        store(session.receivedApplicationContext)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        store(applicationContext)
    }

    private func store(_ context: [String: Any]) {
        guard let json = context["snapshot"] as? String, WidgetSnapshot.parse(json) != nil else { return }
        WidgetSnapshot.store(json)
        WidgetCenter.shared.reloadAllTimelines()
        NotificationCenter.default.post(name: Self.didUpdate, object: nil)
    }
}
