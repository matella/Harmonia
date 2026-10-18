package harmonia.companion.widgets

import android.content.Context
import harmonia.core.WidgetSnapshot

/**
 * The only data widgets read: the versioned snapshot JSON written by the app through
 * HarmoniaWidgetsPlugin. It lives in app-private SharedPreferences, so widgets work after
 * process death and reboot without the WebView. It is a disposable cache — the SQLite
 * database remains the source of truth.
 */
object SnapshotStore {
    private const val PREFS = "harmonia_widget"
    private const val KEY_SNAPSHOT = "snapshot"

    fun write(context: Context, json: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SNAPSHOT, json).commit()
    }

    fun readJson(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SNAPSHOT, null)

    fun read(context: Context): WidgetSnapshot? = WidgetSnapshot.parse(readJson(context))
}

/** Per-widget-instance display choices from the configuration screen. */
object WidgetConfigStore {
    private const val PREFS = "harmonia_widget_config"

    fun counterMode(context: Context, widgetId: Int): String? =
        prefs(context).getString("counter_$widgetId", null)

    fun showDetails(context: Context, widgetId: Int): Boolean =
        prefs(context).getBoolean("details_$widgetId", true)

    fun save(context: Context, widgetId: Int, counterMode: String?, showDetails: Boolean) {
        prefs(context).edit()
            .apply { if (counterMode == null) remove("counter_$widgetId") else putString("counter_$widgetId", counterMode) }
            .putBoolean("details_$widgetId", showDetails)
            .apply()
    }

    fun delete(context: Context, widgetIds: IntArray) {
        val editor = prefs(context).edit()
        for (id in widgetIds) editor.remove("counter_$id").remove("details_$id")
        editor.apply()
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
