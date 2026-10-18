import { isSafeUsageEvent, type UsageEvent } from '../domain/usage-events';

/**
 * Opt-in anonymous usage events, sent to Aptabase (https://aptabase.com — open source,
 * EU or US cloud, or self-hosted). The only network code in Harmonia.
 *
 * What leaves the device, per event: the event name and its whitelisted properties
 * (see core/domain/usage-events.ts), a timestamp, an in-memory session ID that is new
 * on every cold start, and four system properties — language, OS name, app version and
 * a debug flag. No device model, OS version, advertising ID or persistent identifier.
 */
export interface UsageConfig {
  /** Aptabase app key: `A-EU-…`, `A-US-…`, or `A-SH-…` for a self-hosted server. */
  appKey: string;
  /** Required for self-hosted keys, e.g. `https://analytics.example.org`. */
  host?: string;
}

export interface UsageSystemProps {
  locale: string;
  osName: string;
  appVersion: string;
  isDebug: boolean;
  sdkVersion: string;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    credentials: 'omit';
    referrerPolicy: 'no-referrer';
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

/** The events endpoint for a key, or null when the key or host is unusable. */
export function aptabaseEndpoint(config: UsageConfig): string | null {
  const region = /^A-(EU|US|SH)-[A-Za-z0-9]+$/.exec(config.appKey)?.[1];
  if (!region) return null;
  if (region === 'SH') {
    if (!config.host || !/^https:\/\/[^\s/]+/.test(config.host)) return null;
    return `${config.host.replace(/\/+$/, '')}/api/v0/events`;
  }
  return `https://${region.toLowerCase()}.aptabase.com/api/v0/events`;
}

interface QueuedEvent {
  timestamp: string;
  sessionId: string;
  eventName: string;
  props: Record<string, string | boolean>;
  attempts: number;
}

const MAX_BATCH = 25;
const MAX_QUEUE = 200;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
/** Aptabase convention: a new session after an hour without events. */
const SESSION_IDLE_MS = 60 * 60 * 1000;
/** After a failed send, wait this long before trying again (e.g. while offline). */
const RETRY_BACKOFF_MS = 60 * 1000;

export interface UsageRecorderDeps {
  endpoint: string;
  appKey: string;
  /** Read at send time, so the language and build flag are current. */
  system: () => UsageSystemProps;
  fetch: FetchLike;
  /** Current time as epoch milliseconds (injected so tests control it). */
  nowMs: () => number;
  random: () => number;
}

/**
 * Consent-gated, in-memory event queue. Nothing is recorded while disabled, turning it
 * off discards whatever is queued, and nothing is ever written to disk.
 */
export class UsageRecorder {
  private enabled = false;
  private queue: QueuedEvent[] = [];
  private sessionId: string;
  private lastEventMs = 0;
  private flushing: Promise<void> | null = null;
  private retryAfterMs = 0;

  constructor(private readonly deps: UsageRecorderDeps) {
    this.sessionId = this.newSessionId();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get pending(): number {
    return this.queue.length;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.discard();
  }

  /** Drops every queued event and starts a new session. */
  discard(): void {
    this.queue = [];
    this.sessionId = this.newSessionId();
  }

  record(event: UsageEvent): void {
    if (!this.enabled || !isSafeUsageEvent(event)) return;
    const now = this.deps.nowMs();
    if (this.lastEventMs && now - this.lastEventMs > SESSION_IDLE_MS) this.sessionId = this.newSessionId();
    this.lastEventMs = now;
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push({
      timestamp: new Date(now).toISOString(),
      sessionId: this.sessionId,
      eventName: event.name,
      props: { ...event.props },
      attempts: 0,
    });
  }

  /** Sends queued events in batches of 25; failed batches are retried a few times, then dropped. */
  flush(): Promise<void> {
    this.flushing ??= this.sendAll().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async sendAll(): Promise<void> {
    if (this.deps.nowMs() < this.retryAfterMs) return;
    while (this.enabled && this.queue.length > 0) {
      const batch = this.queue.splice(0, MAX_BATCH);
      const ok = await this.send(batch);
      if (ok) continue;
      // Requeue what may be retried and stop until the next flush.
      const retry = batch.filter((e) => ++e.attempts < MAX_ATTEMPTS);
      if (this.enabled) this.queue.unshift(...retry);
      this.retryAfterMs = this.deps.nowMs() + RETRY_BACKOFF_MS;
      return;
    }
  }

  private async send(batch: QueuedEvent[]): Promise<boolean> {
    const systemProps = this.deps.system();
    const body = batch.map(({ attempts: _attempts, ...event }) => ({ ...event, systemProps }));
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const response = await this.deps.fetch(this.deps.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'App-Key': this.deps.appKey },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
      // 4xx means the server rejected the content; retrying would not help.
      return response.ok || (response.status >= 400 && response.status < 500);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private newSessionId(): string {
    const seconds = Math.floor(this.deps.nowMs() / 1000);
    const random = Math.floor(this.deps.random() * 100_000_000)
      .toString()
      .padStart(8, '0');
    return `${seconds}${random}`;
  }
}
