import Capacitor
import Foundation
import WidgetKit

/// Native side of src/app/core/platform/widget-bridge.ts.
///
/// Stores the versioned widget snapshot in the shared App Group (read by the WidgetKit
/// extension), asks WidgetKit to reload timelines, and forwards the snapshot to the
/// Apple Watch with WatchConnectivity. The SQLite database stays the source of truth.
@objc(HarmoniaWidgetsPlugin)
public class HarmoniaWidgetsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HarmoniaWidgetsPlugin"
    public let jsName = "HarmoniaWidgets"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "writeSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reloadAll", returnType: CAPPluginReturnPromise),
    ]

    static let appGroup = "group.harmonia.companion"
    static let snapshotKey = "snapshot"
    static let supportedSchemaVersion = 1

    @objc func writeSnapshot(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), Self.isSupported(json) else {
            call.reject("Invalid or unsupported widget snapshot")
            return
        }
        guard let defaults = UserDefaults(suiteName: Self.appGroup) else {
            call.reject("App Group \(Self.appGroup) is not configured")
            return
        }
        defaults.set(json, forKey: Self.snapshotKey)
        WidgetCenter.shared.reloadAllTimelines()
        WatchBridge.shared.send(snapshot: json)
        call.resolve()
    }

    @objc func reloadAll(_ call: CAPPluginCall) {
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    /// Minimal validation; the full contract is parsed by HarmoniaCore in the extensions.
    static func isSupported(_ json: String) -> Bool {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = object["schemaVersion"] as? Int else { return false }
        return version == supportedSchemaVersion
    }
}
