package harmonia.companion.wear

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.LongTextComplicationData
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.MonochromaticImageComplicationData
import androidx.wear.watchface.complications.data.NoDataComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationDataTimeline
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingTimelineComplicationDataSourceService
import androidx.wear.watchface.complications.datasource.TimeInterval
import androidx.wear.watchface.complications.datasource.TimelineEntry
import harmonia.core.Glance
import harmonia.core.GlanceContent
import harmonia.core.WidgetSnapshot
import java.time.Instant
import java.time.ZoneId

/**
 * Day-count complication. Instead of polling, it hands the watch face a timeline with
 * one entry per upcoming day (computed from the cached start date), so the count rolls
 * over at midnight even when the phone is out of reach.
 */
class DaysComplicationService : SuspendingTimelineComplicationDataSourceService() {

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationDataTimeline? {
        val snapshot = WearSnapshotStore.read(this)
        val zone = snapshot?.calendarZone ?: ZoneId.systemDefault()
        val now = Instant.now()
        val current = build(request.complicationType, snapshot, now)
        val entries = mutableListOf<TimelineEntry>()
        var dayStart = Glance.nextDayBoundary(snapshot, now, zone)
        repeat(TIMELINE_DAYS) {
            val dayEnd = Glance.nextDayBoundary(snapshot, dayStart, zone)
            entries += TimelineEntry(TimeInterval(dayStart, dayEnd), build(request.complicationType, snapshot, dayStart))
            dayStart = dayEnd
        }
        return ComplicationDataTimeline(current, entries)
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? = when (type) {
        ComplicationType.SHORT_TEXT -> shortText(getString(R.string.preview_days), getString(R.string.complication_days_label))
        ComplicationType.LONG_TEXT -> longText(getString(R.string.preview_duration), getString(R.string.app_name))
        ComplicationType.MONOCHROMATIC_IMAGE -> image()
        else -> null
    }

    private fun build(type: ComplicationType, snapshot: WidgetSnapshot?, at: Instant): ComplicationData {
        val content = Glance.resolve(snapshot, at, ZoneId.systemDefault())
        if (content !is GlanceContent.Counter) {
            // Degrade to the brand mark (or no data) rather than showing stale personal data.
            return if (type == ComplicationType.MONOCHROMATIC_IMAGE || type == ComplicationType.SHORT_TEXT) {
                if (type == ComplicationType.SHORT_TEXT) shortText("—", getString(R.string.app_name)) else image()
            } else {
                longText(getString(R.string.watch_placeholder), getString(R.string.app_name))
            }
        }
        val texts = WatchTexts(this, content)
        return when (type) {
            ComplicationType.SHORT_TEXT -> shortText(texts.daysNumber, texts.daysLabel)
            ComplicationType.LONG_TEXT -> {
                val next = texts.nextLine
                if (next != null) longText(next, texts.daysTogether) else longText(texts.duration, texts.daysTogether)
            }
            ComplicationType.MONOCHROMATIC_IMAGE -> image()
            else -> NoDataComplicationData()
        }
    }

    private fun shortText(text: String, title: String): ComplicationData =
        ShortTextComplicationData.Builder(plain(text), plain("$text $title"))
            .setTitle(plain(title))
            .setMonochromaticImage(mark())
            .setTapAction(openApp())
            .build()

    private fun longText(text: String, title: String): ComplicationData =
        LongTextComplicationData.Builder(plain(text), plain("$title. $text"))
            .setTitle(plain(title))
            .setMonochromaticImage(mark())
            .setTapAction(openApp())
            .build()

    private fun image(): ComplicationData =
        MonochromaticImageComplicationData.Builder(mark(), plain(getString(R.string.app_name)))
            .setTapAction(openApp())
            .build()

    private fun mark() = MonochromaticImage.Builder(Icon.createWithResource(this, R.drawable.ic_complication_mark)).build()

    private fun plain(text: String) = PlainComplicationText.Builder(text).build()

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, WearMainActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    companion object {
        private const val TIMELINE_DAYS = 7
    }
}

/** Localized strings shared by the complication and the watch screen. */
class WatchTexts(context: Context, content: GlanceContent.Counter) {
    private val res = context.resources
    private val days = content.totalDays.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    val daysNumber: String = java.text.NumberFormat.getIntegerInstance().format(content.totalDays)
    val daysLabel: String = res.getQuantityString(R.plurals.days_label, days)
    val daysTogether: String = res.getQuantityString(R.plurals.days_together, days, daysNumber)
    val duration: String = run {
        val c = content.calendar
        val parts = buildList {
            if (c.years > 0) add(res.getQuantityString(R.plurals.years, c.years, c.years))
            if (c.months > 0) add(res.getQuantityString(R.plurals.months, c.months, c.months))
            if (c.days > 0 || isEmpty()) add(res.getQuantityString(R.plurals.days, c.days, c.days))
        }
        parts.joinToString(context.getString(R.string.list_separator))
    }
    val nextLine: String? = content.next?.let { next ->
        val inDays = next.daysUntil.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        val whenText = if (inDays == 0) context.getString(R.string.today) else res.getQuantityString(R.plurals.in_days, inDays, inDays)
        context.getString(R.string.next_line, next.title ?: context.getString(R.string.next_untitled), whenText)
    }
    val name: String? = content.name
}
