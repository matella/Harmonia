import { describe, expect, it } from 'vitest';

import { makeMilestone, makeProfile, makeRule, settings } from '../../../testing/fixtures';
import { buildExportDocument, EXPORT_SCHEMA_VERSION, parseExportDocument } from './export-format';
import type { Memory } from './models';

const meta = { exportedAt: '2026-10-18T10:00:00Z', appVersion: '1.0.0', databaseSchemaVersion: 1 };

function source() {
  const milestone = makeMilestone({ title: 'First trip', photoPath: 'media/m1.jpg' });
  const memory: Memory = {
    id: 'mem-1',
    milestoneId: milestone.id,
    title: 'Lisbon',
    body: 'Tram 28',
    memoryDate: '2025-05-01',
    media: [
      { id: 'md-1', memoryId: 'mem-1', filePath: 'media/a.jpg', thumbnailPath: 'media/thumbs/a.jpg', sortOrder: 0, createdAt: meta.exportedAt },
      { id: 'md-2', memoryId: 'mem-1', filePath: 'media/b.jpg', thumbnailPath: null, sortOrder: 1, createdAt: meta.exportedAt },
    ],
    createdAt: meta.exportedAt,
    updatedAt: meta.exportedAt,
  };
  return {
    profile: makeProfile({ displayName: 'Sam', photoPath: 'media/profile.jpg' }),
    settings: settings(),
    milestones: [milestone],
    reminderRules: [makeRule(milestone.id, { offsetDays: 1 })],
    memories: [memory],
  };
}

describe('buildExportDocument', () => {
  it('contains every record with versioned metadata and archive paths', () => {
    const doc = buildExportDocument(source(), meta, new Set(['media/a.jpg', 'media/b.jpg', 'media/profile.jpg']));
    expect(doc).toMatchObject({ format: 'harmonia-export', schemaVersion: EXPORT_SCHEMA_VERSION, appVersion: '1.0.0' });
    expect(doc.profile?.displayName).toBe('Sam');
    expect(doc.profile?.photoArchivePath).toBe('media/profile.jpg');
    expect(doc.milestones).toHaveLength(1);
    expect(doc.reminderRules).toHaveLength(1);
    expect(doc.memories[0].media.map((m) => m.archivePath)).toEqual(['media/a.jpg', 'media/b.jpg']);
    expect(doc.mediaComplete).toBe(false); // the date's photo wasn't included
  });

  it('includes date photos (version 2)', () => {
    const all = new Set(['media/a.jpg', 'media/b.jpg', 'media/profile.jpg', 'media/m1.jpg']);
    const doc = buildExportDocument(source(), meta, all);
    expect(EXPORT_SCHEMA_VERSION).toBe(2);
    expect(doc.milestones[0].photoArchivePath).toBe('media/m1.jpg');
    expect(doc.mediaComplete).toBe(true);
  });

  it('flags missing media instead of silently claiming completeness', () => {
    const doc = buildExportDocument(source(), meta, new Set(['media/a.jpg']));
    expect(doc.mediaComplete).toBe(false);
    expect(doc.memories[0].media[1].archivePath).toBeNull();
  });
});

describe('parseExportDocument', () => {
  it('round-trips a built document', () => {
    const doc = buildExportDocument(source(), meta, new Set());
    const parsed = parseExportDocument(JSON.stringify(doc));
    expect(parsed.ok && parsed.document.milestones[0].title).toBe('First trip');
  });

  it('rejects other files, newer versions and corrupted content', () => {
    expect(parseExportDocument('not json')).toEqual({ ok: false, reason: 'notJson' });
    expect(parseExportDocument('{"format":"other"}')).toEqual({ ok: false, reason: 'wrongFormat' });
    const doc = buildExportDocument(source(), meta, new Set());
    expect(parseExportDocument(JSON.stringify({ ...doc, schemaVersion: EXPORT_SCHEMA_VERSION + 1 }))).toEqual({
      ok: false,
      reason: 'unsupportedVersion',
    });
    const broken = { ...doc, milestones: [{ ...doc.milestones[0], eventDate: '2025-02-30' }] };
    expect(parseExportDocument(JSON.stringify(broken))).toEqual({ ok: false, reason: 'invalidContent' });
  });

  it('fills settings added in later app versions with defaults', () => {
    const doc = buildExportDocument(source(), meta, new Set());
    const { timelineOrder: _dropped, ...olderSettings } = doc.settings;
    const parsed = parseExportDocument(JSON.stringify({ ...doc, settings: olderSettings }));
    expect(parsed.ok && parsed.document.settings.timelineOrder).toBe('oldest');
  });
});
