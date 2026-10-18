package harmonia.companion.widgets

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import harmonia.core.Glance
import java.time.Instant
import java.time.ZoneId

/**
 * Re-renders widgets shortly after the counter's local midnight using an *inexact* alarm
 * (AlarmManager.set — no exact-alarm permission). The OS may deliver it late; widgets
 * recompute from the start date whenever they are drawn, and updatePeriodMillis (6 h)
 * plus time/zone-change broadcasts provide further refresh opportunities.
 */
object DayBoundaryScheduler {
    const val ACTION_REFRESH = "harmonia.companion.widgets.REFRESH"
    private const val REQUEST_CODE = 7001
    private const val SLACK_MS = 60_000L

    fun schedule(context: Context) {
        val alarms = context.getSystemService(AlarmManager::class.java) ?: return
        val boundary = Glance.nextDayBoundary(SnapshotStore.read(context), Instant.now(), ZoneId.systemDefault())
        alarms.set(AlarmManager.RTC, boundary.toEpochMilli() + SLACK_MS, pendingIntent(context))
    }

    fun cancel(context: Context) {
        context.getSystemService(AlarmManager::class.java)?.cancel(pendingIntent(context))
    }

    private fun pendingIntent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            Intent(context, WidgetRefreshReceiver::class.java).setAction(ACTION_REFRESH),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}

/**
 * Handles the day-boundary alarm and system clock events (time set, time-zone or locale
 * change, reboot, app update) so widgets never keep showing yesterday's count.
 */
class WidgetRefreshReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in HANDLED_ACTIONS) return
        WidgetUpdater.updateAll(context)
    }

    private companion object {
        val HANDLED_ACTIONS = setOf(
            DayBoundaryScheduler.ACTION_REFRESH,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED,
            Intent.ACTION_DATE_CHANGED,
            Intent.ACTION_LOCALE_CHANGED,
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
        )
    }
}
