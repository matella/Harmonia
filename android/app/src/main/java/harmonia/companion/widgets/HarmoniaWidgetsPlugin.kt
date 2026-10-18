package harmonia.companion.widgets

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import harmonia.core.WidgetSnapshot

/**
 * Bridge used by src/app/core/platform/widget-bridge.ts. Validates and stores the
 * snapshot, re-renders widgets, and forwards the snapshot to Wear OS.
 */
@CapacitorPlugin(name = "HarmoniaWidgets")
class HarmoniaWidgetsPlugin : Plugin() {
    @PluginMethod
    fun writeSnapshot(call: PluginCall) {
        val json = call.getString("json")
        if (json.isNullOrEmpty() || WidgetSnapshot.parse(json) == null) {
            call.reject("Invalid or unsupported widget snapshot")
            return
        }
        SnapshotStore.write(context, json)
        WidgetUpdater.updateAll(context)
        WearSync.send(context, json)
        call.resolve()
    }

    @PluginMethod
    fun reloadAll(call: PluginCall) {
        WidgetUpdater.updateAll(context)
        call.resolve()
    }
}
