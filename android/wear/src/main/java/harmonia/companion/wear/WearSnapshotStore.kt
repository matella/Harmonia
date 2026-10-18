package harmonia.companion.wear

import android.content.Context
import harmonia.core.WidgetSnapshot

/** Cached copy of the phone's snapshot. A disposable cache; the phone is the source of truth. */
object WearSnapshotStore {
    private const val PREFS = "harmonia_watch"
    private const val KEY = "snapshot"
    private const val KEY_RECEIVED = "received_at"

    fun write(context: Context, json: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY, json)
            .putLong(KEY_RECEIVED, System.currentTimeMillis())
            .commit()
    }

    fun read(context: Context): WidgetSnapshot? =
        WidgetSnapshot.parse(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null))

    fun receivedAt(context: Context): Long? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_RECEIVED, 0L).takeIf { it > 0 }
}
