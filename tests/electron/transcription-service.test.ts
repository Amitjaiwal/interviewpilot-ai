import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../../electron/history-store';
import { Logger } from '../../electron/logger';
import { TranscriptionService } from '../../electron/stt/transcription-service';
import type { EngineSnapshot, TranscribeOptions, WhisperEngine } from '../../electron/stt/whisper-engine';
import type { SttEvent } from '../../shared/ipc';
import { DEFAULT_SETTINGS, Settings, sanitizeSettings } from '../../shared/settings';

/** A scriptable stand-in for the whisper server. */
class StubEngine {
  status: EngineSnapshot = { state: 'stopped' };
  replies: string[] = [];
  calls: { bytes: number; prompt: string; opts?: TranscribeOptions }[] = [];
  failStart = false;
  private listeners = new Set<(s: EngineSnapshot) => void>();

  onChange(l: (s: EngineSnapshot) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  async ensureReady() {
    this.set(this.failStart ? { state: 'error', error: 'whisper.cpp is not installed' } : { state: 'ready', url: 'stub' });
  }
  async transcribe(wav: Buffer, prompt: string, opts?: TranscribeOptions) {
    this.calls.push({ bytes: wav.length, prompt, opts });
    return this.replies.shift() ?? '';
  }
  private set(s: EngineSnapshot) {
    this.status = s;
    this.listeners.forEach((l) => l(s));
  }
}

const RATE = 16_000;
const tone = (ms: number) => {
  const n = (RATE * ms) / 1000;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 200 * i) / RATE) * 9000 * (i % 4000 < 3600 ? 1 : 0.1));
  return out;
};
const silence = (ms: number) => new Int16Array((RATE * ms) / 1000);
const tick = () => new Promise((r) => setTimeout(r, 0));

let dir: string;
let engine: StubEngine;
let events: SttEvent[];
let settings: Settings;
let history: HistoryStore;
let service: TranscriptionService;

function feed(audio: Int16Array) {
  for (let i = 0; i < audio.length; i += 1600) service.pushAudio('mic', audio.slice(i, i + 1600));
}

async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ip-stt-'));
  engine = new StubEngine();
  events = [];
  settings = sanitizeSettings({ ...DEFAULT_SETTINGS, stt: { ...DEFAULT_SETTINGS.stt, partials: false } });
  history = new HistoryStore(path.join(dir, 'history'));
  service = new TranscriptionService(
    engine as unknown as WhisperEngine,
    () => settings,
    history,
    new Logger(path.join(dir, 'log.txt')),
    (e) => events.push(e),
    path.join(dir, 'rec'),
  );
});

afterEach(() => {
  history.flush();
  rmSync(dir, { recursive: true, force: true });
});

const finals = () => events.filter((e): e is Extract<SttEvent, { type: 'final' }> => e.type === 'final');

describe('TranscriptionService', () => {
  it('turns an utterance into a cleaned final event and records it in history', async () => {
    engine.replies = [' [BLANK_AUDIO] What is dependency injection?\n'];
    await service.start({ sessionId: 'live-unit01', sources: ['mic'] });
    await settle();
    feed(tone(1200));
    feed(silence(1000));
    await settle();

    expect(finals()).toHaveLength(1);
    expect(finals()[0]).toEqual(expect.objectContaining({ source: 'mic', text: 'What is dependency injection?', question: true }));
    history.flush();
    expect(history.get('live-unit01')?.transcript.map((t) => t.text)).toEqual(['What is dependency injection?']);
  });

  it('reuses the transcription started at the pause as the final', async () => {
    engine.replies = ['How does garbage collection work?', 'should never be used'];
    await service.start({ sessionId: 'live-unit08', sources: ['mic'] });
    await settle();
    feed(tone(1500));
    feed(silence(400));
    // The speculation finishes while the speaker is still silent...
    await settle();
    expect(finals()).toHaveLength(0);
    feed(silence(600));
    await settle();

    // ...and becomes the final without a second inference.
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].opts).toEqual(expect.objectContaining({ fast: false }));
    expect(finals()).toEqual([expect.objectContaining({ text: 'How does garbage collection work?', question: true })]);
  });

  it('discards the speculation when the speaker continues after a pause', async () => {
    engine.replies = ['Tell me about', 'Tell me about Kafka partitions'];
    await service.start({ sessionId: 'live-unit09', sources: ['mic'] });
    await settle();
    feed(tone(1000));
    feed(silence(400));
    await settle();
    feed(tone(1000));
    feed(silence(1000));
    await settle();

    expect(engine.calls).toHaveLength(2);
    expect(engine.calls[1].bytes).toBeGreaterThan(engine.calls[0].bytes);
    expect(finals().map((f) => f.text)).toEqual(['Tell me about Kafka partitions']);
  });

  it('prompts with the vocabulary only, never the previous sentence, and strips repeated words', async () => {
    engine.replies = ['We use Kafka for event streaming', 'event streaming and Redis for caching'];
    await service.start({ sessionId: 'live-unit02', sources: ['mic'] });
    await settle();
    feed(tone(1000));
    feed(silence(1000));
    await settle();
    feed(tone(1000));
    feed(silence(1000));
    await settle();

    expect(finals().map((f) => f.text)).toEqual(['We use Kafka for event streaming', 'and Redis for caching']);
    // A previous sentence in the prompt makes whisper copy it on unclear audio.
    expect(engine.calls.map((c) => c.prompt)).toEqual([DEFAULT_SETTINGS.stt.vocabulary, DEFAULT_SETTINGS.stt.vocabulary]);
  });

  it('sends no prompt when the vocabulary is empty', async () => {
    settings = { ...settings, stt: { ...settings.stt, vocabulary: '' } };
    engine.replies = ['We use Kafka', 'and Redis'];
    await service.start({ sessionId: 'live-unit03', sources: ['mic'] });
    await settle();
    feed(tone(1000));
    feed(silence(1000));
    await settle();
    feed(tone(1000));
    feed(silence(1000));
    await settle();

    expect(engine.calls.map((c) => c.prompt)).toEqual(['', '']);
  });

  it('drops a line that only repeats the previous one, however often whisper loops it', async () => {
    engine.replies = ['It will be more than a little longer.', 'It will be more than a little longer. It will be more than a little longer.'];
    await service.start({ sessionId: 'live-unit10', sources: ['mic'] });
    await settle();
    feed(tone(1000));
    feed(silence(1000));
    await settle();
    feed(tone(1000));
    feed(silence(1000));
    await settle();

    expect(finals().map((f) => f.text)).toEqual(['It will be more than a little longer.', '']);
  });

  it('emits an empty final for hallucinated silence so the UI can drop the line', async () => {
    engine.replies = ['Thank you.'];
    await service.start({ sessionId: 'live-unit03', sources: ['mic'] });
    await settle();
    feed(tone(800));
    feed(silence(1000));
    await settle();
    expect(finals()).toEqual([expect.objectContaining({ text: '' })]);
    history.flush();
    expect(history.get('live-unit03')).toBeNull();
  });

  it('flushes speech in progress on pause and ignores audio while paused', async () => {
    engine.replies = ['first part', 'should never be used'];
    await service.start({ sessionId: 'live-unit04', sources: ['mic'] });
    await settle();
    feed(tone(1000));
    service.pause();
    await settle();
    expect(finals().map((f) => f.text)).toEqual(['first part']);
    feed(tone(1000));
    feed(silence(1000));
    await settle();
    expect(engine.calls).toHaveLength(1);
    expect(service.status().capture).toBe('paused');
  });

  it('does not save history when history is disabled', async () => {
    settings = sanitizeSettings({ ...settings, privacy: { ...settings.privacy, saveHistory: false } });
    engine.replies = ['Private sentence here'];
    await service.start({ sessionId: 'live-unit05', sources: ['mic'] });
    await settle();
    feed(tone(1000));
    feed(silence(1000));
    await settle();
    history.flush();
    expect(finals()[0].text).toBe('Private sentence here');
    expect(history.get('live-unit05')).toBeNull();
  });

  it('stops capture when the speech engine cannot start', async () => {
    engine.failStart = true;
    await service.start({ sessionId: 'live-unit06', sources: ['mic'] });
    await settle();
    const status = service.status();
    expect(status.capture).toBe('idle');
    expect(status.engine).toBe('error');
    expect(status.error).toContain('not installed');
    expect(service.isCapturing('mic')).toBe(false);
  });

  it('only reports capturing for the sources that were started', async () => {
    await service.start({ sessionId: 'live-unit07', sources: ['system'] });
    expect(service.isCapturing('system')).toBe(true);
    expect(service.isCapturing('mic')).toBe(false);
    await service.stop();
    expect(service.isCapturing('system')).toBe(false);
  });
});
