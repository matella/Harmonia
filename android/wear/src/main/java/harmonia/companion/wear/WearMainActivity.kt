package harmonia.companion.wear

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import androidx.wear.remote.interactions.RemoteActivityHelper
import harmonia.core.Glance
import harmonia.core.GlanceContent
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId

private val Berry = Color(0xFFD18A9A)
private val Ink = Color(0xFFF5EEEC)
private val InkMuted = Color(0xFFC0B0B3)
private val OnBerry = Color(0xFF1D1518)

/**
 * Glanceable watch screen: duration, total days and the next date (privacy permitting).
 * Editing stays on the phone; a button opens the phone app.
 */
class WearMainActivity : ComponentActivity() {
    private var content by mutableStateOf<GlanceContent>(GlanceContent.Placeholder)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { WatchScreen(content, onOpenPhone = ::openOnPhone) } }
        lifecycleScope.launch {
            // Recompute whenever the screen is visible; nothing runs in the background.
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                content = Glance.resolve(WearSnapshotStore.read(this@WearMainActivity), Instant.now(), ZoneId.systemDefault())
            }
        }
    }

    private fun openOnPhone() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("harmonia://home")).addCategory(Intent.CATEGORY_BROWSABLE)
        // Fire-and-forget: the phone shows Harmonia if it is reachable.
        runCatching { RemoteActivityHelper(this).startRemoteActivity(intent) }
    }
}

@Composable
private fun WatchScreen(content: GlanceContent, onOpenPhone: () -> Unit) {
    val listState = rememberScalingLazyListState()
    val context = LocalContext.current
    ScalingLazyColumn(
        state = listState,
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        item {
            Text(
                text = stringResource(R.string.app_name),
                color = InkMuted,
                fontFamily = FontFamily.Serif,
                fontSize = 13.sp,
                modifier = Modifier.semantics { heading() },
            )
        }
        when (content) {
            GlanceContent.Placeholder -> item {
                Text(
                    text = stringResource(R.string.watch_placeholder),
                    color = Ink,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
            is GlanceContent.Counter -> {
                val texts = WatchTexts(context, content)
                item {
                    Text(
                        text = texts.duration,
                        color = Berry,
                        fontFamily = FontFamily.Serif,
                        fontSize = 22.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 12.dp),
                    )
                }
                item { Text(text = texts.daysTogether, color = Ink, fontSize = 14.sp, textAlign = TextAlign.Center) }
                texts.nextLine?.let { line ->
                    item {
                        Text(
                            text = line,
                            color = InkMuted,
                            fontSize = 13.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        )
                    }
                }
            }
        }
        item {
            Button(
                onClick = onOpenPhone,
                colors = ButtonDefaults.buttonColors(containerColor = Berry, contentColor = OnBerry),
                modifier = Modifier.padding(top = 8.dp),
            ) {
                Text(stringResource(R.string.open_on_phone))
            }
        }
    }
}
