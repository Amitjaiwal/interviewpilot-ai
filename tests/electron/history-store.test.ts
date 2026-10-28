import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../../electron/history-store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ip-history-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const exchange = (prompt: string, response = 'answer') => ({
  mode: 'answer' as const,
  prompt,
  response,
  model: 'm',
  at: Date.now(),
});

describe('HistoryStore', () => {
  it('records transcripts and exchanges and persists them on flush', () => {
    const store = new HistoryStore(dir);
    store.appendTranscript('live-session-1', { source: 'system', text: 'Tell me about Kafka partitions', at: 1 });
    store.appendExchange('live-session-1', 'live', exchange('Tell me about Kafka partitions'));
    store.flush();

    const reopened = new HistoryStore(dir);
    const s = reopened.get('live-session-1');
    expect(s?.transcript).toHaveLength(1);
    expect(s?.exchanges).toHaveLength(1);
    expect(s?.title).toBe('Tell me about Kafka partitions');
  });

  it('lists sessions newest first and searches all text with a snippet', async () => {
    const store = new HistoryStore(dir);
    store.appendExchange('chat-aaaaaa', 'chat', exchange('Explain the volatile keyword'));
    await new Promise((r) => setTimeout(r, 5));
    store.appendExchange('chat-bbbbbb', 'chat', exchange('What is a B-tree index?', 'Databases use B-trees for ordered lookups'));

    expect(store.list().map((s) => s.id)).toEqual(['chat-bbbbbb', 'chat-aaaaaa']);
    const hits = store.list('ordered LOOKUPS');
    expect(hits.map((s) => s.id)).toEqual(['chat-bbbbbb']);
    expect(hits[0].snippet).toContain('ordered lookups');
    expect(store.list('nothing matches this')).toEqual([]);
  });

  it('deletes one session or all of them', () => {
    const store = new HistoryStore(dir);
    store.appendExchange('chat-aaaaaa', 'chat', exchange('a'));
    store.appendExchange('chat-bbbbbb', 'chat', exchange('b'));
    store.flush();
    store.delete('chat-aaaaaa');
    expect(store.list().map((s) => s.id)).toEqual(['chat-bbbbbb']);
    store.clear();
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('prunes sessions older than the retention window', () => {
    const store = new HistoryStore(dir);
    store.appendExchange('chat-old000', 'chat', exchange('old'));
    store.get('chat-old000')!.updatedAt = Date.now() - 40 * 86_400_000;
    store.appendExchange('chat-new000', 'chat', exchange('new'));
    expect(store.prune(30)).toBe(1);
    expect(store.list().map((s) => s.id)).toEqual(['chat-new000']);
    expect(store.prune(0)).toBe(0);
  });

  it('recreates its folder if it was deleted while running', () => {
    const store = new HistoryStore(dir);
    rmSync(dir, { recursive: true, force: true });
    store.appendExchange('chat-gone00', 'chat', exchange('still saved'));
    store.flush();
    expect(new HistoryStore(dir).get('chat-gone00')?.title).toBe('still saved');
  });

  it('rejects ids that could escape the history folder', () => {
    const store = new HistoryStore(dir);
    store.appendExchange('../../evil', 'chat', exchange('x'));
    expect(store.get('../../evil')).toBeNull();
    store.flush();
    expect(readdirSync(dir)).toEqual([]);
  });
});
