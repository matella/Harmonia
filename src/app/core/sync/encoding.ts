/** Byte encodings used by sharing: base64 for the secure store, `\x…` hex for Postgres bytea. */

export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** PostgREST reads and writes bytea as `\x` followed by hex. */
export function toBytea(bytes: Uint8Array): string {
  let hex = '\\x';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function fromBytea(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^\\x([0-9a-f]{2})*$/i.test(value)) {
    throw new Error('Not a bytea value');
  }
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return bytes;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
}
