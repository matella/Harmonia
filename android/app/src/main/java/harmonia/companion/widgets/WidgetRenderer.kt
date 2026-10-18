package harmonia.companion.widgets

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateFormat
import android.view.View
import android.widget.RemoteViews
import harmonia.companion.R
import harmonia.core.CalendarDuration
import harmonia.core.CounterMode
import harmonia.core.Glance
import harmonia.core.GlanceConfig
import harmonia.core.GlanceContent
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

enum class WidgetSize { SMALL, MEDIUM }

/** Builds RemoteViews from the snapshot; recomputes the day count at render time. */
object WidgetRenderer {
    fun render(context: Context, widgetId: Int, size: WidgetSize, now: Instant = Instant.now()): RemoteViews {
        val config = GlanceConfig(
            counterMode = when (WidgetConfigStore.counterMode(context, widgetId)) {
                "days" -> CounterMode.DAYS
                "calendar" -> CounterMode.CALENDAR
                else -> null
            },
            showDetails = WidgetConfigStore.showDetails(context, widgetId),
        )
        val content = runCatching {
            Glance.resolve(SnapshotStore.read(context), now, ZoneId.systemDefault(), config)
        }.getOrDefault(GlanceContent.Placeholder)

        val layout = if (size == WidgetSize.SMALL) R.layout.widget_small else R.layout.widget_medium
        val views = RemoteViews(context.packageName, layout)
        views.setOnClickPendingIntent(R.id.widget_root, openApp(context, "harmonia://home", widgetId * 2))

        when (content) {
            GlanceContent.Placeholder -> renderPlaceholder(context, views, size)
            is GlanceContent.Counter -> renderCounter(context, views, size, content, widgetId)
        }
        return views
    }

    private fun renderPlaceholder(context: Context, views: RemoteViews, size: WidgetSize) {
        views.setViewVisibility(R.id.widget_mark, View.VISIBLE)
        views.setViewVisibility(R.id.widget_primary, View.GONE)
        views.setTextViewText(R.id.widget_secondary, context.getString(R.string.widget_placeholder))
        if (size == WidgetSize.MEDIUM) {
            views.setViewVisibility(R.id.widget_label, View.VISIBLE)
            views.setTextViewText(R.id.widget_label, context.getString(R.string.app_name))
            views.setViewVisibility(R.id.widget_next_group, View.GONE)
            views.setViewVisibility(R.id.widget_divider, View.GONE)
        }
        views.setContentDescription(R.id.widget_root, context.getString(R.string.widget_placeholder))
    }

    private fun renderCounter(context: Context, views: RemoteViews, size: WidgetSize, c: GlanceContent.Counter, widgetId: Int) {
        val res = context.resources
        val locale = res.configuration.locales[0] ?: Locale.getDefault()
        val days = NumberFormat.getIntegerInstance(locale).format(c.totalDays)
        val daysPlural = c.totalDays.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()

        val primary: String
        val secondary: String
        if (c.counterMode == CounterMode.CALENDAR && c.totalDays > 0) {
            primary = shortDuration(context, c.calendar)
            secondary = res.getQuantityString(R.plurals.widget_days_together, daysPlural, days)
        } else {
            primary = days
            secondary = res.getQuantityString(R.plurals.widget_days_label, daysPlural)
        }
        views.setViewVisibility(R.id.widget_primary, View.VISIBLE)
        views.setTextViewText(R.id.widget_primary, primary)
        views.setTextViewText(R.id.widget_secondary, secondary)
        views.setViewVisibility(R.id.widget_mark, if (c.showBrand) View.VISIBLE else View.GONE)

        val description = StringBuilder(res.getQuantityString(R.plurals.widget_days_together, daysPlural, days))
        if (size == WidgetSize.MEDIUM) {
            val label = c.name?.let { context.getString(R.string.widget_with_name, it) }
                ?: if (c.showBrand) context.getString(R.string.app_name) else null
            views.setViewVisibility(R.id.widget_label, if (label != null) View.VISIBLE else View.GONE)
            views.setTextViewText(R.id.widget_label, label ?: "")
            val next = c.next
            if (next != null) {
                val inDays = next.daysUntil.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
                views.setViewVisibility(R.id.widget_next_group, View.VISIBLE)
                views.setViewVisibility(R.id.widget_divider, View.VISIBLE)
                views.setTextViewText(R.id.widget_next_title, next.title ?: context.getString(R.string.widget_next_untitled))
                views.setTextViewText(R.id.widget_next_date, monthDay(context, next.date, locale))
                views.setTextViewText(
                    R.id.widget_next_in,
                    if (inDays == 0) context.getString(R.string.widget_today)
                    else res.getQuantityString(R.plurals.widget_in_days, inDays, NumberFormat.getIntegerInstance(locale).format(inDays)),
                )
                views.setOnClickPendingIntent(R.id.widget_next_group, openApp(context, "harmonia://dates", widgetId * 2 + 1))
                description.append(". ").append(next.title ?: "").append(", ").append(monthDay(context, next.date, locale))
            } else {
                views.setViewVisibility(R.id.widget_next_group, View.GONE)
                views.setViewVisibility(R.id.widget_divider, View.GONE)
            }
        }
        views.setContentDescription(R.id.widget_root, description.toString())
    }

    private fun shortDuration(context: Context, d: CalendarDuration): String {
        val res = context.resources
        val years = if (d.years > 0) res.getQuantityString(R.plurals.widget_years, d.years, d.years) else null
        val months = if (d.months > 0) res.getQuantityString(R.plurals.widget_months, d.months, d.months) else null
        return when {
            years != null && months != null -> context.getString(R.string.widget_years_months, years, months)
            years != null -> years
            months != null -> months
            else -> res.getQuantityString(R.plurals.widget_days_together, d.days, d.days.toString())
        }
    }

    private fun monthDay(context: Context, date: LocalDate, locale: Locale): String {
        val pattern = DateFormat.getBestDateTimePattern(locale, "dMMMM")
        return DateTimeFormatter.ofPattern(pattern, locale).format(date)
    }

    fun openApp(context: Context, link: String, requestCode: Int): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
