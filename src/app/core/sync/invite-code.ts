/**
 * The invite as text (docs/PARTNER_SYNC.md §6.1): `H1.` followed by 64 base64url
 * characters holding the invite ID (16 bytes) and the invite secret (32 bytes). The
 * secret never reaches the server; whoever has the code can claim the invite, which then
 * still needs the inviter's approval. It is found even inside a pasted message.
 */
export interface InviteCode {
  inviteId: string;
  secret: Uint8Array;
}

const PREFIX = 'H1.';
const PATTERN = /H1\.([A-Za-z0-9_-]{64})(?![A-Za-z0-9_-])/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function formatInviteCode({ inviteId, secret }: InviteCode): string {
  if (!UUID.test(inviteId) || secret.length !== 32) throw new Error('Invalid invite');
  const bytes = new Uint8Array(48);
  bytes.set(uuidToBytes(inviteId), 0);
  bytes.set(secret, 16);
  return PREFIX + toBase64Url(bytes);
}

/** The first invite code found in `text`, or null. */
export function parseInviteCode(text: string): InviteCode | null {
  const match = PATTERN.exec(text);
  if (!match) return null;
  const bytes = fromBase64Url(match[1]);
  if (bytes.length !== 48) return null;
  return { inviteId: bytesToUuid(bytes.slice(0, 16)), secret: bytes.slice(16) };
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
