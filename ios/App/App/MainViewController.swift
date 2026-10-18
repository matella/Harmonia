import Capacitor
import UIKit

/// Bridge view controller that registers Harmonia's app-local Capacitor plugins.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HarmoniaWidgetsPlugin())
        WatchBridge.shared.activate()
    }
}
