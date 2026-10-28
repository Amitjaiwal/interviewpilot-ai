import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ExchangeEntry, HistoryKind, HistorySession, HistorySummary, TranscriptEntry } from '../shared/ipc';

export const SESSION_ID = /^[A-Za-z0-9_-]{6,64}$/;

const DEFAULT_TITLES: Record<HistoryKind, string> = {
  live: 'Live session',
  chat: 'Study chat',
  practice: 'Practice',
};

const MAX_ENTRIES = 5000;

/**
 * Local session history: one JSON file per session in the user-data folder.
 * Writes are batched per session so a stream of transcript segments does not
 * hit the disk on every line.
 */
export class HistoryStore {
  private readonly cache = new Map<string, HistorySession>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dir: string,
    private readonly flushDelayMs = 1000,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  get path(): string {
    return this.dir;
  }

  appendTranscript(id: string, entry: TranscriptEntry): void {
    const s = this.session(id, 'live');
    if (!s) return;
    if (s.transcript.length < MAX_ENTRIES) s.transcript.push(entry);
    if (s.title === DEFAULT_TITLES[s.kind] && s.exchanges.length === 0) s.title = titleFrom(entry.text);
    this.touch(s);
  }

  appendExchange(id: string, kind: HistoryKind, entry: ExchangeEntry): void {
    const s = this.session(id, kind);
    if (!s) return;
    if (s.exchanges.length < MAX_ENTRIES) s.exchanges.push(entry);
    if (s.exchanges.length === 1 && (s.title === DEFAULT_TITLES[s.kind] || s.kind !== 'live')) {
      s.title = titleFrom(entry.prompt);
    }
    this.touch(s);
  }

  get(id: string): HistorySession | null {
    if (!SESSION_ID.test(id)) return null;
    return this.cache.get(id) ?? this.read(id);
  }

  list(query = ''): HistorySummary[] {
    const q = query.trim().toLowerCase();
    const summaries: HistorySummary[] = [];
    for (const id of this.ids()) {
      const s = this.get(id);
      if (!s) continue;
      let snippet: string | undefined;
      if (q) {
        snippet = findSnippet(s, q);
        if (snippet === undefined) continue;
      }
      summaries.push({
        id: s.id,
        kind: s.kind,
        title: s.title,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        transcriptCount: s.transcript.length,
        exchangeCount: s.exchanges.length,
        snippet,
      });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): void {
    if (!SESSION_ID.test(id)) return;
    this.cache.delete(id);
    this.dirty.delete(id);
    rmSync(this.file(id), { force: true });
  }

  clear(): void {
    this.cache.clear();
    this.dirty.clear();
    for (const id of this.ids()) rmSync(this.file(id), { force: true });
  }

  /** Delete sessions not updated within `days` days. 0 disables pruning. */
  prune(days: number, now = Date.now()): number {
    if (days <= 0) return 0;
    const cutoff = now - days * 86_400_000;
    let removed = 0;
    for (const id of this.ids()) {
      const s = this.get(id);
      if (s && s.updatedAt < cutoff) {
        this.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Write all pending sessions now (call on quit). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.dirty.size === 0) return;
    // The folder may have been deleted by hand while the app was running.
    mkdirSync(this.dir, { recursive: true });
    for (const id of this.dirty) {
      const s = this.cache.get(id);
      if (!s) continue;
      try {
        const tmp = `${this.file(id)}.tmp`;
        writeFileSync(tmp, JSON.stringify(s));
        renameSync(tmp, this.file(id));
      } catch {
        // A failed write must not take the app down; the session stays cached and is retried next flush.
        continue;
      }
      this.dirty.delete(id);
    }
  }

  private session(id: string, kind: HistoryKind): HistorySession | null {
    if (!SESSION_ID.test(id)) return null;
    let s = this.get(id);
    if (!s) {
      const now = Date.now();
      s = { id, kind, title: DEFAULT_TITLES[kind], startedAt: now, updatedAt: now, transcript: [], exchanges: [] };
    }
    this.cache.set(id, s);
    return s;
  }

  private touch(s: HistorySession): void {
    s.updatedAt = Date.now();
    this.dirty.add(s.id);
    this.timer ??= setTimeout(() => this.flush(), this.flushDelayMs);
  }

  private read(id: string): HistorySession | null {
    const file = this.file(id);
    if (!existsSync(file)) return null;
    try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as HistorySession;
      return s && s.id === id && Array.isArray(s.transcript) && Array.isArray(s.exchanges) ? s : null;
    } catch {
      return null;
    }
  }

  private ids(): string[] {
    const onDisk = existsSync(this.dir)
      ? readdirSync(this.dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.slice(0, -5))
          .filter((id) => SESSION_ID.test(id))
      : [];
    return [...new Set([...onDisk, ...this.cache.keys()])];
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 70 ? `${t.slice(0, 67)}...` : t || 'Untitled';
}

function findSnippet(s: HistorySession, q: string): string | undefined {
  const texts = [s.title, ...s.transcript.map((t) => t.text), ...s.exchanges.flatMap((e) => [e.prompt, e.response])];
  for (const text of texts) {
    const i = text.toLowerCase().indexOf(q);
    if (i >= 0) {
      const start = Math.max(0, i - 50);
      return (start > 0 ? '...' : '') + text.slice(start, i + q.length + 70).replace(/\s+/g, ' ');
    }
  }
  return undefined;
}
