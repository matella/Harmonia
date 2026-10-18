package harmonia.companion;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import harmonia.companion.widgets.HarmoniaWidgetsPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local Capacitor plugins must be registered before the bridge starts.
        registerPlugin(HarmoniaWidgetsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
