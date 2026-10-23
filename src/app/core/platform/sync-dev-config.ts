import type { SyncServerConfig } from './sync-config';

declare const ngDevMode: unknown;

/**
 * Development builds only: the local Supabase stack started with `bunx supabase start`.
 * The URL and key are the Supabase CLI's public local defaults, identical on every
 * machine. Release builds define `ngDevMode` as false, so this folds to null and the
 * values are not in the bundle (checked in docs/PARTNER_SYNC.md §17).
 */
export const DEV_SYNC_CONFIG: SyncServerConfig | null =
  typeof ngDevMode !== 'undefined' && ngDevMode
    ? {
        url: 'http://127.0.0.1:54321',
        publishableKey: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
      }
    : null;
