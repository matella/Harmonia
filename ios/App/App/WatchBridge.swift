import Foundation
import WatchConnectivity

/// Sends the minimal widget snapshot to the paired Apple Watch.
///
/// Uses `updateApplicationContext`, which keeps only the latest value and delivers it
/// when the watch app next becomes reachable — no polling, no network, no cloud.
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()
    private var pendingSnapshot: String?

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        if session.activationState != .activated { session.activate() }
    }

    func send(snapshot json: String) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else {
            pendingSnapshot = json
            activate()
            return
        }
        guard session.isPaired, session.isWatchAppInstalled else { return }
        try? session.updateApplicationContext(["snapshot": json])
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated, let json = pendingSnapshot else { return }
        pendingSnapshot = nil
        send(snapshot: json)
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate to support switching between paired watches.
        session.activate()
    }
}
