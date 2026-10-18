package harmonia.companion.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context

/** Shared behaviour for both widget sizes. */
abstract class HarmoniaWidgetProvider(private val size: WidgetSize) : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, widgetIds: IntArray) {
        for (id in widgetIds) manager.updateAppWidget(id, WidgetRenderer.render(context, id, size))
        DayBoundaryScheduler.schedule(context)
    }

    override fun onEnabled(context: Context) {
        DayBoundaryScheduler.schedule(context)
    }

    override fun onDeleted(context: Context, widgetIds: IntArray) {
        WidgetConfigStore.delete(context, widgetIds)
    }

    override fun onDisabled(context: Context) {
        if (!WidgetUpdater.hasAnyWidget(context)) DayBoundaryScheduler.cancel(context)
    }
}

/** 2×2: day count and brand mark. */
class HarmoniaSmallWidget : HarmoniaWidgetProvider(WidgetSize.SMALL)

/** 4×2: counter plus the next date (privacy permitting). */
class HarmoniaMediumWidget : HarmoniaWidgetProvider(WidgetSize.MEDIUM)

object WidgetUpdater {
    private val providers = listOf(
        HarmoniaSmallWidget::class.java to WidgetSize.SMALL,
        HarmoniaMediumWidget::class.java to WidgetSize.MEDIUM,
    )

    /** Re-renders every placed widget from the current snapshot. */
    fun updateAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context) ?: return
        for ((provider, size) in providers) {
            for (id in manager.getAppWidgetIds(ComponentName(context, provider))) {
                manager.updateAppWidget(id, WidgetRenderer.render(context, id, size))
            }
        }
        if (hasAnyWidget(context)) DayBoundaryScheduler.schedule(context)
    }

    fun update(context: Context, widgetId: Int) {
        val manager = AppWidgetManager.getInstance(context) ?: return
        for ((provider, size) in providers) {
            if (manager.getAppWidgetIds(ComponentName(context, provider)).contains(widgetId)) {
                manager.updateAppWidget(widgetId, WidgetRenderer.render(context, widgetId, size))
            }
        }
    }

    fun hasAnyWidget(context: Context): Boolean {
        val manager = AppWidgetManager.getInstance(context) ?: return false
        return providers.any { (provider, _) -> manager.getAppWidgetIds(ComponentName(context, provider)).isNotEmpty() }
    }
}
