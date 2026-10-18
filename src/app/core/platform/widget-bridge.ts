import { registerPlugin } from '@capacitor/core';

/**
 * Native bridge implemented by the app (not a third-party plugin):
 *  - Android: `HarmoniaWidgetsPlugin.kt` writes SharedPreferences "harmonia_widget",
 *    updates every AppWidget and forwards the snapshot to Wear OS via the Data Layer.
 *  - iOS: `HarmoniaWidgetsPlugin.swift` writes the App Group UserDefaults, calls
 *    WidgetCenter.reloadAllTimelines() and sends the snapshot to the watch with
 *    WatchConnectivity.
 * The payload is the versioned WidgetSnapshot JSON (docs/WIDGET_SNAPSHOT.md).
 */
export interface HarmoniaWidgetsPlugin {
  /** Persists the snapshot and asks the OS to refresh widgets/complications. */
  writeSnapshot(options: { json: string }): Promise<void>;
  /** Re-requests a refresh without changing data (e.g. after a day boundary). */
  reloadAll(): Promise<void>;
  /** Native build flavour; used only to flag usage events from test builds. */
  buildInfo(): Promise<{ debuggable: boolean }>;
}

const noop: HarmoniaWidgetsPlugin = {
  writeSnapshot: async () => undefined,
  reloadAll: async () => undefined,
  buildInfo: async () => ({ debuggable: true }),
};

export const HarmoniaWidgets = registerPlugin<HarmoniaWidgetsPlugin>('HarmoniaWidgets', {
  web: () => noop,
});
