import type { UsageConfig } from './usage-analytics';

/**
 * Destination for opt-in anonymous usage events. While this is null the feature does
 * not exist: no prompt, no setting, no network request.
 *
 * To enable it, create an app in Aptabase (EU region recommended) or on a self-hosted
 * Aptabase server and set, for example:
 *   export const USAGE_CONFIG: UsageConfig | null = { appKey: 'A-EU-0000000000' };
 *   export const USAGE_CONFIG: UsageConfig | null = { appKey: 'A-SH-0000000000', host: 'https://analytics.example.org' };
 * The destination shown to users ("Aptabase (EU)", or the server's name) is derived from it.
 * Also review docs/RELEASE_CHECKLIST.md (store privacy labels, privacy policy).
 */
export const USAGE_CONFIG: UsageConfig | null = null;
