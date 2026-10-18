package harmonia.companion.widgets

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable

/**
 * Sends the widget snapshot to a paired Wear OS watch through the Wearable Data Layer
 * (a DataItem, so it is delivered when the watch next connects). Only the minimal
 * snapshot is sent. Without Google Play services or a paired watch this is a no-op.
 */
object WearSync {
    const val PATH = "/harmonia/snapshot"
    const val KEY_JSON = "json"
    private const val TAG = "HarmoniaWearSync"

    fun send(context: Context, json: String) {
        try {
            val request = PutDataMapRequest.create(PATH).apply {
                dataMap.putString(KEY_JSON, json)
                dataMap.putLong("sentAt", System.currentTimeMillis())
            }.asPutDataRequest().setUrgent()
            Wearable.getDataClient(context).putDataItem(request)
                .addOnFailureListener { Log.i(TAG, "Watch sync unavailable") }
        } catch (_: Exception) {
            // Play services missing or Data Layer unavailable: the phone app keeps working.
            Log.i(TAG, "Watch sync unavailable")
        }
    }
}
