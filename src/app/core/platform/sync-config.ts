/**
 * The partner-sharing server (docs/PARTNER_SYNC.md §4). While this is null, sharing does
 * not exist in the app: no screen, no setting, no network request.
 *
 * Set it to a Supabase project in the EU with the migrations in `supabase/migrations`, e.g.
 *   export const SYNC_CONFIG: SyncServerConfig | null = {
 *     url: 'https://<project>.supabase.co',
 *     publishableKey: 'sb_publishable_…',
 *   };
 * The publishable key is public by design; access is limited by row-level security.
 */
export interface SyncServerConfig {
  url: string;
  publishableKey: string;
}

export const SYNC_CONFIG: SyncServerConfig | null = null;
