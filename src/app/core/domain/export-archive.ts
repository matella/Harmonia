import { Unzip, UnzipInflate } from 'fflate';

/**
 * Reading an export archive (ZIP) as a stream, entry by entry, so a large export never
 * sits in memory at once. Only the entries asked for are decompressed, each up to a size
 * limit; a file that isn't a ZIP, or an entry over the limit, stops the read.
 */

export type ArchiveFailure = 'notZip' | 'tooLarge';

export class ArchiveError extends Error {
  constructor(readonly reason: ArchiveFailure) {
    super(`Archive: ${reason}`);
  }
}

export interface ArchiveReadOptions {
  /** Entries to decompress; everything else is skipped. */
  wanted: (name: string) => boolean;
  /** Called once per wanted entry, in archive order, before more input is read. */
  onEntry: (name: string, bytes: Uint8Array) => Promise<void> | void;
  maxEntryBytes: number;
}

export async function readArchive(
  stream: ReadableStream<Uint8Array>,
  options: ArchiveReadOptions,
): Promise<void> {
  const done: { name: string; bytes: Uint8Array }[] = [];
  // Set from fflate's callbacks, so kept in an object TypeScript doesn't narrow.
  const state: { failure: ArchiveFailure | null } = { failure: null };

  const unzip = new Unzip((file) => {
    if (!options.wanted(file.name)) return;
    if ((file.originalSize ?? 0) > options.maxEntryBytes) {
      state.failure = 'tooLarge';
      return;
    }
    const parts: Uint8Array[] = [];
    let length = 0;
    file.ondata = (error, chunk, final) => {
      if (state.failure) return;
      if (error) {
        state.failure = 'notZip';
        return;
      }
      length += chunk.length;
      if (length > options.maxEntryBytes) {
        state.failure = 'tooLarge';
        file.terminate();
        return;
      }
      parts.push(chunk);
      if (final) done.push({ name: file.name, bytes: concat(parts, length) });
    };
    try {
      file.start();
    } catch {
      state.failure = 'notZip'; // a compression method the app never writes
    }
  });
  unzip.register(UnzipInflate);

  const reader = stream.getReader();
  let sawZip = false;
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (!sawZip && value && value.length >= 4) {
        // Local file header: "PK\x03\x04".
        sawZip = value[0] === 0x50 && value[1] === 0x4b && value[2] === 0x03 && value[3] === 0x04;
        if (!sawZip) throw new ArchiveError('notZip');
      }
      try {
        unzip.push(value ?? new Uint8Array(0), end);
      } catch {
        throw new ArchiveError('notZip');
      }
      if (state.failure) throw new ArchiveError(state.failure);
      while (done.length > 0) {
        const entry = done.shift()!;
        await options.onEntry(entry.name, entry.bytes);
      }
      if (end) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (!sawZip) throw new ArchiveError('notZip');
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
