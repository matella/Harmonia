import { Capacitor } from '@capacitor/core';
import { TextZoom } from '@capacitor/text-zoom';

/**
 * Applies the system text size to the web view. Android's WebView already follows the
 * system font scale; WKWebView on iOS does not follow Dynamic Type, so the preferred
 * zoom is applied explicitly (at launch and on every resume).
 */
export async function applyPreferredTextScale(): Promise<void> {
  if (Capacitor.getPlatform() !== 'ios') return;
  try {
    const { value } = await TextZoom.getPreferred();
    await TextZoom.set({ value });
  } catch {
    // Keep the default size if the plugin is unavailable.
  }
}
