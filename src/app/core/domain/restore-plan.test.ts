import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { makeMilestone, makeProfile, makeRule, settings } from '../../../testing/fixtures';
import { ArchiveError, readArchive } from './export-archive';
import {
  buildExportDocument,
  EXPORT_JSON_NAME,
  parseExportDocument,
  type ExportDocument,
} from './export-format';
import type { Memory } from './models';
import { planRestore } from './restore-plan';
import { Temporal } from './temporal';

const today = Temporal.PlainDate.from('2026-10-24');
const meta = { exportedAt: '2026-10-20T10:00:00Z', appVersion: '1.0.0', databaseSchemaVersion: 8 };

function exportDocument(): ExportDocument {
  const trip = makeMilestone({
    id: 'trip',
    title: 'First trip',
    photoPath: 'media/trip.jpg',
    recurrence: 'yearly',
  });
  const memory: Memory = {
    id: 'lisbon',
    milestoneId: 'trip',
    title: 'Lisbon',
    body: null,
    memoryDate: '2025-05-01',
    media: [
      {
        id: 'x2',
        memoryId: 'lisbon',
        filePath: 'media/b.jpg',
        thumbnailPath: null,
        sortOrder: 1,
        createdAt: meta.exportedAt,
      },
      {
        id: 'x1',
        memoryId: 'lisbon',
        filePath: 'media/a.jpg',
        thumbnailPath: null,
        sortOrder: 0,
        createdAt: meta.exportedAt,
      },
    ],
    createdAt: meta.exportedAt,
    updatedAt: meta.exportedAt,
  };
  return buildExportDocument(
    {
      profile: makeProfile({ displayName: 'Sam', selfName: 'Alex', photoPath: 'media/me.jpg' }),
      settings: settings({
        theme: 'dark',
        appLock: true,
        usageSharing: true,
        usagePromptAnswered: true,
      }),
      milestones: [trip],
      reminderRules: [
        makeRule('trip', { offsetDays: 1 }),
        makeRule('trip', { offsetDays: 0, isEnabled: false }),
      ],
      memories: [memory],
    },
    meta,
    new Set(['media/me.jpg', 'media/trip.jpg', 'media/a.jpg', 'media/b.jpg']),
  );
}

/** Through JSON, like a real file. */
function roundTrip(doc: unknown): ExportDocument {
  const parsed = parseExportDocument(JSON.stringify(doc));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.document;
}

describe('planRestore', () => {
  it('keeps IDs and links, orders photos, and restores enabled reminders only', () => {
    const result = planRestore(roundTrip(exportDocument()), today);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { plan } = result;
    expect(plan.profile).toMatchObject({
      displayName: 'Sam',
      selfName: 'Alex',
      startDate: '2024-06-14',
    });
    expect(plan.profilePhoto).toBe('media/me.jpg');
    expect(plan.milestones[0]).toMatchObject({ id: 'trip', photo: 'media/trip.jpg' });
    expect(plan.milestones[0].value.reminders.map((r) => r.offsetDays)).toEqual([1]);
    expect(plan.memories[0]).toMatchObject({
      id: 'lisbon',
      photos: ['media/a.jpg', 'media/b.jpg'],
    });
    expect(plan.memories[0].value.milestoneId).toBe('trip');
    expect(plan.photoPaths.sort()).toEqual([
      'media/a.jpg',
      'media/b.jpg',
      'media/me.jpg',
      'media/trip.jpg',
    ]);
  });

  it('leaves out settings that belong to the phone: consent and the app lock', () => {
    const result = planRestore(roundTrip(exportDocument()), today);
    if (!result.ok) throw new Error('not ok');
    expect(result.plan.settings.theme).toBe('dark');
    for (const key of ['appLock', 'appLockAfter', 'usageSharing', 'usagePromptAnswered']) {
      expect(key in result.plan.settings).toBe(false);
    }
  });

  it('reads a version 1 export, which had no date photos', () => {
    const doc = exportDocument();
    const v1 = {
      ...doc,
      schemaVersion: 1,
      milestones: doc.milestones.map(({ photoArchivePath: _p, ...rest }) => rest),
    };
    const result = planRestore(roundTrip(v1), today);
    expect(result.ok && result.plan.milestones[0].photo).toBeNull();
  });

  it('drops a link to a date that is not in the file, and counts photos the export lacked', () => {
    const doc = exportDocument();
    doc.memories[0].milestoneId = 'gone';
    doc.memories[0].media[0].archivePath = null;
    const result = planRestore(roundTrip(doc), today);
    if (!result.ok) throw new Error('not ok');
    expect(result.plan.memories[0].value.milestoneId).toBeNull();
    expect(result.plan.memories[0].photos).toHaveLength(1);
    expect(result.plan.photosNotInExport).toBe(1);
  });

  it('refuses a file the app could never have written', () => {
    const cases: ((doc: ExportDocument) => void)[] = [
      (doc) => (doc.profile = null),
      (doc) => (doc.profile!.startDate = '2027-01-01'), // a start date in the future
      (doc) => (doc.milestones[0].photoArchivePath = '../../shared_prefs/x.jpg'),
      (doc) => (doc.memories[0].media[0].archivePath = 'media/thumbs/../a.jpg'),
      (doc) => (doc.memories[0].id = 'trip'), // the same ID twice
      (doc) => (doc.milestones[0].title = 'x'.repeat(500)),
      (doc) => (doc.memories[0].id = 'has spaces'),
    ];
    for (const damage of cases) {
      const doc = exportDocument();
      damage(doc);
      expect(planRestore(doc, today)).toEqual({ ok: false, reason: 'invalidContent' });
    }
  });
});

function streamOf(bytes: Uint8Array, chunk = 1000): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

describe('readArchive', () => {
  const photo = new Uint8Array(5000).map((_, i) => i % 251);
  const zip = zipSync({
    'media/a.jpg': [photo, { level: 0 }],
    'media/b.jpg': [photo, { level: 0 }],
    [EXPORT_JSON_NAME]: strToU8('{"format":"harmonia-export"}'),
  });

  it('decompresses only the entries asked for, in small chunks', async () => {
    const seen: string[] = [];
    await readArchive(streamOf(zip), {
      wanted: (name) => name === EXPORT_JSON_NAME || name === 'media/b.jpg',
      onEntry: (name, bytes) => {
        seen.push(name);
        if (name === 'media/b.jpg')
          expect(Buffer.from(bytes).equals(Buffer.from(photo))).toBe(true);
      },
      maxEntryBytes: 1 << 20,
    });
    expect(seen).toEqual(['media/b.jpg', EXPORT_JSON_NAME]);
  });

  it('stops at an entry over the limit, and at a file that is not a ZIP', async () => {
    const read = (bytes: Uint8Array, max: number) =>
      readArchive(streamOf(bytes), {
        wanted: () => true,
        onEntry: () => undefined,
        maxEntryBytes: max,
      });
    await expect(read(zip, 100)).rejects.toEqual(new ArchiveError('tooLarge'));
    await expect(read(strToU8('{"format":"harmonia-export"}'), 1 << 20)).rejects.toEqual(
      new ArchiveError('notZip'),
    );
    await expect(read(new Uint8Array(0), 1 << 20)).rejects.toEqual(new ArchiveError('notZip'));
  });
});
