package harmonia.companion.wear

import android.content.ComponentName
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService
import harmonia.core.WidgetSnapshot

/** Stores snapshots pushed by the phone and asks the watch face to refresh complications. */
class SnapshotListenerService : WearableListenerService() {
    override fun onDataChanged(events: DataEventBuffer) {
        var updated = false
        for (event in events) {
            if (event.type != DataEvent.TYPE_CHANGED || event.dataItem.uri.path != PATH) continue
            val json = DataMapItem.fromDataItem(event.dataItem).dataMap.getString(KEY_JSON) ?: continue
            if (WidgetSnapshot.parse(json) == null) continue
            WearSnapshotStore.write(this, json)
            updated = true
        }
        if (updated) requestComplicationUpdate()
    }

    private fun requestComplicationUpdate() {
        ComplicationDataSourceUpdateRequester
            .create(this, ComponentName(this, DaysComplicationService::class.java))
            .requestUpdateAll()
    }

    companion object {
        const val PATH = "/harmonia/snapshot"
        const val KEY_JSON = "json"
    }
}
