import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { strToU8, zipSync, type Zippable } from 'fflate';

import { archivePathFor, buildExportDocument, EXPORT_JSON_NAME, type ExportDocument } from '../domain/export-format';
import { MediaStorageService } from '../platform/media-storage.service';
import { LATEST_SCHEMA_VERSION } from '../persistence/migrations';
import { AppStore } from '../state/app-store';
import { DatabaseService } from './database.service';
import { APP_VERSION, CLOCK } from './tokens';

export interface ExportResult {
  fileName: string;
  document: ExportDocument;
  /** False when the user dismissed the share sheet without saving. */
  shared: boolean;
}

/**
 * Builds a local ZIP archive (JSON + copies of app-private photos) and hands it to the
 * system share sheet / file saver. Nothing is uploaded by the app itself.
 */
@Injectable({ providedIn: 'root' })
export class DataExportService {
  private readonly db = inject(DatabaseService);
  private readonly store = inject(AppStore);
  private readonly media = inject(MediaStorageService);
  private readonly clock = inject(CLOCK);

  async buildArchive(): Promise<{ bytes: Uint8Array; document: ExportDocument; fileName: string }> {
    const { profile, milestones, memories, settings } = this.db.repos;
    const [p, m, rules, mem, s] = await Promise.all([
      profile.get(),
      milestones.list(),
      milestones.listRules(),
      memories.list(),
      settings.load(),
    ]);

    const files: Zippable = {};
    const included = new Set<string>();
    const wanted = [
      ...(p?.photoPath ? [p.photoPath] : []),
      ...m.flatMap((milestone) => (milestone.photoPath ? [milestone.photoPath] : [])),
      ...mem.flatMap((memory) => memory.media.map((media) => media.filePath)),
    ];
    for (const path of wanted) {
      const base64 = await this.media.readBase64(path);
      if (base64 === null) continue;
      // JPEGs are already compressed; store them without deflate.
      files[archivePathFor(path)] = [base64ToBytes(base64), { level: 0 }];
      included.add(path);
    }

    const now = this.clock.now();
    const document = buildExportDocument(
      { profile: p, settings: s, milestones: m, reminderRules: rules, memories: mem },
      { exportedAt: now.toString(), appVersion: APP_VERSION, databaseSchemaVersion: LATEST_SCHEMA_VERSION },
      included,
    );
    files[EXPORT_JSON_NAME] = strToU8(JSON.stringify(document, null, 2));
    const date = now.toZonedDateTimeISO(this.store.deviceTimeZone()).toPlainDate().toString();
    return { bytes: zipSync(files), document, fileName: `harmonia-export-${date}.zip` };
  }

  async exportAndShare(dialogTitle: string): Promise<ExportResult> {
    const { bytes, document, fileName } = await this.buildArchive();
    if (!Capacitor.isNativePlatform()) {
      downloadInBrowser(bytes, fileName);
      return { fileName, document, shared: true };
    }
    // The receiving app may read the file after the share sheet closes, so the previous
    // export (not this one) is cleared here. The OS may also purge the cache directory.
    await Filesystem.rmdir({ path: 'exports', directory: Directory.Cache, recursive: true }).catch(() => undefined);
    const written = await Filesystem.writeFile({
      path: `exports/${fileName}`,
      data: bytesToBase64(bytes),
      directory: Directory.Cache,
      recursive: true,
    });
    try {
      await Share.share({ title: dialogTitle, files: [written.uri], dialogTitle });
      return { fileName, document, shared: true };
    } catch (error) {
      if (/cancel/i.test(error instanceof Error ? error.message : String(error))) {
        return { fileName, document, shared: false };
      }
      throw error;
    }
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function downloadInBrowser(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
