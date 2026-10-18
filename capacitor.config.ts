import type { CapacitorConfig } from '@capacitor/cli';

/**
 * App identifiers are a replaceable product slug, deliberately not derived from a
 * domain name (see docs/BRANDING.md for how to rename before release).
 */
const config: CapacitorConfig = {
  appId: 'harmonia.companion',
  appName: 'Harmonia',
  webDir: 'dist/harmonia/browser',
  backgroundColor: '#F8F3ED',
  // The native bridge would otherwise log plugin call results (SQL rows, notification
  // bodies) to logcat/Xcode in debug builds. Privacy rule: never log user data.
  loggingBehavior: 'none',
  android: {
    allowMixedContent: false,
    captureInput: false,
  },
  ios: {
    contentInset: 'never',
    // Required for @capacitor/text-zoom (Dynamic Type) to apply on iPad.
    preferredContentMode: 'mobile',
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_harmonia',
      iconColor: '#6D243B',
    },
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: false,
      androidIsEncryption: false,
    },
  },
};

export default config;
