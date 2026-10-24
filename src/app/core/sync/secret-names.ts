/**
 * Every name partner sharing uses in the secure key store, so "Delete all data" can forget
 * them without loading any sharing code. Space keys are `space.<spaceId>.<epoch>`.
 */
export const DEVICE_SECRETS = {
  keys: 'device.keys',
  id: 'device.id',
  secret: 'device.secret',
  nextSecret: 'device.secret.next',
  authPrefix: 'auth.',
} as const;

export const SHARING_SECRETS = {
  pendingKey: 'sharing.pendingKey',
  invite: 'sharing.invite',
  join: 'sharing.join',
  rotation: 'sharing.rotation',
  recover: 'sharing.recover',
  leaving: 'sharing.leaving',
} as const;

/** The Supabase session is kept under this storage key (prefixed with `auth.`). */
export const AUTH_STORAGE_KEY = 'session';

export const spaceKeyName = (spaceId: string, epoch: number) => `space.${spaceId}.${epoch}`;

/** Every fixed name; space keys come on top. */
export function allSharingSecretNames(): string[] {
  return [
    DEVICE_SECRETS.keys,
    DEVICE_SECRETS.id,
    DEVICE_SECRETS.secret,
    DEVICE_SECRETS.nextSecret,
    DEVICE_SECRETS.authPrefix + AUTH_STORAGE_KEY,
    `${DEVICE_SECRETS.authPrefix}${AUTH_STORAGE_KEY}-user`,
    `${DEVICE_SECRETS.authPrefix}${AUTH_STORAGE_KEY}-code-verifier`,
    ...Object.values(SHARING_SECRETS),
  ];
}
