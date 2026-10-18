package harmonia.companion.widgets

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.RadioGroup
import android.widget.Switch
import harmonia.companion.R

/**
 * Per-widget options: counter style and whether the name/next date may appear. These
 * can only make a widget more discreet than the app-wide privacy setting.
 * Launched when a widget is added (before Android 12) or reconfigured.
 */
class WidgetConfigureActivity : Activity() {
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        widgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        setContentView(R.layout.widget_configure)

        val counter = findViewById<RadioGroup>(R.id.config_counter)
        val details = findViewById<Switch>(R.id.config_details)
        counter.check(
            when (WidgetConfigStore.counterMode(this, widgetId)) {
                "days" -> R.id.config_counter_days
                "calendar" -> R.id.config_counter_calendar
                else -> R.id.config_counter_app
            },
        )
        details.isChecked = WidgetConfigStore.showDetails(this, widgetId)

        findViewById<Button>(R.id.config_save).setOnClickListener {
            val mode = when (counter.checkedRadioButtonId) {
                R.id.config_counter_days -> "days"
                R.id.config_counter_calendar -> "calendar"
                else -> null
            }
            WidgetConfigStore.save(this, widgetId, mode, details.isChecked)
            WidgetUpdater.update(this, widgetId)
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
            finish()
        }
    }
}
