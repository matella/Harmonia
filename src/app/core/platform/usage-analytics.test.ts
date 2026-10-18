import { describe, expect, it } from 'vitest';

import type { UsageEvent } from '../domain/usage-events';
import { aptabaseEndpoint, UsageRecorder, type FetchLike } from './usage-analytics';

interface Call {
  url: string;
  headers: Record<string, string>;
  credentials: string;
  referrerPolicy: string;
  body: unknown[];
}

function setup(responses: ('ok' | 'fail' | 'reject' | 'bad-request')[] = []) {
  const calls: Call[] = [];
  let now = Date.UTC(2026, 9, 18, 10, 0, 0);
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, credentials: init.credentials, referrerPolicy: init.referrerPolicy, body: JSON.parse(init.body) as unknown[] });
    const next = responses.shift() ?? 'ok';
    if (next === 'reject') throw new TypeError('network down');
    return { ok: next === 'ok', status: next === 'ok' ? 200 : next === 'bad-request' ? 400 : 503 };
  };
  const recorder = new UsageRecorder({
    endpoint: 'https://eu.aptabase.com/api/v0/events',
    appKey: 'A-EU-1234567890',
    system: () => ({ locale: 'fr', osName: 'android', appVersion: '1.0.0', isDebug: true, sdkVersion: 'harmonia-usage@1' }),
    fetch: fetchFn,
    nowMs: () => now,
    random: () => 0.123456789,
  });
  return { recorder, calls, advance: (ms: number) => (now += ms) };
}

const viewed: UsageEvent = { name: 'screen_viewed', props: { screen: 'home' } };

describe('aptabaseEndpoint', () => {
  it('derives the region from the key', () => {
    expect(aptabaseEndpoint({ appKey: 'A-EU-1234567890' })).toBe('https://eu.aptabase.com/api/v0/events');
    expect(aptabaseEndpoint({ appKey: 'A-US-1234567890' })).toBe('https://us.aptabase.com/api/v0/events');
  });

  it('needs an https host for self-hosted keys and rejects anything else', () => {
    expect(aptabaseEndpoint({ appKey: 'A-SH-1234567890', host: 'https://stats.example.org/' })).toBe(
      'https://stats.example.org/api/v0/events',
    );
    expect(aptabaseEndpoint({ appKey: 'A-SH-1234567890' })).toBeNull();
    expect(aptabaseEndpoint({ appKey: 'A-SH-1234567890', host: 'http://stats.example.org' })).toBeNull();
    expect(aptabaseEndpoint({ appKey: '' })).toBeNull();
    expect(aptabaseEndpoint({ appKey: 'not-a-key' })).toBeNull();
  });
});

describe('UsageRecorder consent', () => {
  it('records nothing until enabled, and never sends what happened before', async () => {
    const { recorder, calls } = setup();
    recorder.record(viewed);
    expect(recorder.pending).toBe(0);
    recorder.setEnabled(true);
    await recorder.flush();
    expect(calls).toHaveLength(0);
  });

  it('turning sharing off discards the queue immediately', async () => {
    const { recorder, calls } = setup();
    recorder.setEnabled(true);
    recorder.record(viewed);
    recorder.setEnabled(false);
    recorder.setEnabled(true);
    await recorder.flush();
    expect(calls).toHaveLength(0);
  });

  it('drops events that fail the schema guard', () => {
    const { recorder } = setup();
    recorder.setEnabled(true);
    recorder.record({ name: 'screen_viewed', props: { screen: 'milestone/abc' } } as unknown as UsageEvent);
    expect(recorder.pending).toBe(0);
  });
});

describe('UsageRecorder transport', () => {
  it('sends exactly the documented fields, without cookies', async () => {
    const { recorder, calls } = setup();
    recorder.setEnabled(true);
    recorder.record({ name: 'date_saved', props: { is_new: true, yearly: false, has_time: false, reminders: true, has_photo: false, pinned: false } });
    await recorder.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://eu.aptabase.com/api/v0/events');
    expect(calls[0].headers).toEqual({ 'Content-Type': 'application/json', 'App-Key': 'A-EU-1234567890' });
    expect(calls[0].credentials).toBe('omit');
    expect(calls[0].referrerPolicy).toBe('no-referrer');
    expect(calls[0].body).toEqual([
      {
        timestamp: '2026-10-18T10:00:00.000Z',
        sessionId: '179231760012345678',
        eventName: 'date_saved',
        props: { is_new: true, yearly: false, has_time: false, reminders: true, has_photo: false, pinned: false },
        systemProps: { locale: 'fr', osName: 'android', appVersion: '1.0.0', isDebug: true, sdkVersion: 'harmonia-usage@1' },
      },
    ]);
  });

  it('sends at most 25 events per request', async () => {
    const { recorder, calls } = setup();
    recorder.setEnabled(true);
    for (let i = 0; i < 30; i++) recorder.record(viewed);
    await recorder.flush();
    expect(calls.map((c) => c.body.length)).toEqual([25, 5]);
    expect(recorder.pending).toBe(0);
  });

  it('retries a failed batch a few times with a back-off, then drops it, and never throws', async () => {
    const { recorder, calls, advance } = setup(['reject', 'fail', 'fail']);
    recorder.setEnabled(true);
    recorder.record(viewed);
    await recorder.flush();
    expect(recorder.pending).toBe(1);
    // Within the back-off nothing is retried, however often flush is called.
    await recorder.flush();
    await recorder.flush();
    expect(calls).toHaveLength(1);
    advance(61_000);
    await recorder.flush();
    advance(61_000);
    await recorder.flush();
    expect(calls).toHaveLength(3);
    expect(recorder.pending).toBe(0);
  });

  it('does not retry content the server rejected', async () => {
    const { recorder, calls } = setup(['bad-request']);
    recorder.setEnabled(true);
    recorder.record(viewed);
    await recorder.flush();
    await recorder.flush();
    expect(calls).toHaveLength(1);
  });

  it('starts a new in-memory session after an hour without events', async () => {
    const { recorder, calls, advance } = setup();
    recorder.setEnabled(true);
    recorder.record(viewed);
    advance(30 * 60 * 1000);
    recorder.record(viewed);
    advance(61 * 60 * 1000);
    recorder.record(viewed);
    await recorder.flush();
    const sessions = (calls[0].body as { sessionId: string }[]).map((e) => e.sessionId);
    expect(sessions[0]).toBe(sessions[1]);
    expect(sessions[2]).not.toBe(sessions[1]);
  });
});
