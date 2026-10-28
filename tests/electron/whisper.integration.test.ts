import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HistoryStore } from '../../electron/history-store';
import { Logger } from '../../electron/logger';
import { TranscriptionService } from '../../electron/stt/transcription-service';
import { WhisperEngine, findModel, findVadModel } from '../../electron/stt/whisper-engine';
import type { SttEvent } from '../../shared/ipc';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../shared/settings';

/**
 * End-to-end speech test against the real whisper.cpp server. It needs the
 * binaries from `npm run setup:whisper` and is skipped when they are missing.
 * The fixture is Windows text-to-speech saying:
 * "Can you explain the difference between a HashMap and a ConcurrentHashMap in Java?"
 */
const whisperRoot = path.resolve('tools', 'whisper');
const available = !!findModel(path.join(whisperRoot, 'models'));
const vadAvailable = !!findVadModel(path.join(whisperRoot, 'models'));

/** Stream audio in 100 ms chunks, in real time, then wait for the next final event. */
async function streamAndWait(service: TranscriptionService, events: SttEvent[], audio: Int16Array) {
  const before = events.filter((e) => e.type === 'final').length;
  for (let i = 0; i < audio.length; i += 1600) {
    service.pushAudio('mic', audio.slice(i, i + 1600));
    await new Promise((r) => setTimeout(r, 20));
  }
  const deadline = Date.now() + 30_000;
  while (events.filter((e) => e.type === 'final').length === before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return events.filter((e): e is Extract<SttEvent, { type: 'final' }> => e.type === 'final').slice(before);
}

/** Read the PCM samples of a 16 kHz mono 16-bit WAV, skipping any extra chunks. */
function readWav(file: string): Int16Array {
  const buf = readFileSync(file);
  let offset = 12;
  while (offset < buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') expect(buf.readUInt32LE(offset + 12)).toBe(16_000);
    if (id === 'data') {
      const data = buf.subarray(offset + 8, offset + 8 + size);
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    offset += 8 + size;
  }
  throw new Error('no data chunk');
}

describe.skipIf(!available)('whisper.cpp integration', () => {
  let tmp: string;
  let engine: WhisperEngine;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'ip-whisper-'));
    engine = new WhisperEngine(new Logger(path.join(tmp, 'log.txt')), [whisperRoot]);
  });

  afterAll(() => {
    engine.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('transcribes streamed microphone-style audio into a final question segment', async () => {
    const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, privacy: { ...DEFAULT_SETTINGS.privacy, captureConsent: true } });
    const events: SttEvent[] = [];
    const history = new HistoryStore(path.join(tmp, 'history'));
    const service = new TranscriptionService(engine, () => settings, history, new Logger(path.join(tmp, 'log.txt')), (e) => events.push(e), path.join(tmp, 'rec'));

    await service.start({ sessionId: 'live-test01', sources: ['mic'] });
    await service.test();
    expect(service.status().engine).toBe('ready');

    // Stream the speech in 100 ms chunks, in real time, followed by silence.
    const speech = readWav(path.join('tests', 'fixtures', 'question-16k.wav'));
    const audio = new Int16Array(speech.length + 16_000 * 1.5);
    audio.set(speech);
    for (let i = 0; i < audio.length; i += 1600) {
      service.pushAudio('mic', audio.slice(i, i + 1600));
      await new Promise((r) => setTimeout(r, 20));
    }

    const deadline = Date.now() + 30_000;
    while (!events.some((e) => e.type === 'final') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const finals = events.filter((e): e is Extract<SttEvent, { type: 'final' }> => e.type === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0].text.toLowerCase()).toMatch(/hash ?map/);
    expect(finals[0].text.toLowerCase()).toContain('java');
    expect(finals[0].question).toBe(true);
    expect(finals[0].source).toBe('mic');

    await service.stop();
    history.flush();
    expect(history.get('live-test01')?.transcript[0].text).toBe(finals[0].text);
  }, 90_000);

  it.skipIf(!vadAvailable)('produces no text for noise after a question (Silero VAD)', async () => {
    const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, privacy: { ...DEFAULT_SETTINGS.privacy, captureConsent: true, saveHistory: false } });
    const events: SttEvent[] = [];
    const history = new HistoryStore(path.join(tmp, 'history-vad'));
    const service = new TranscriptionService(engine, () => settings, history, new Logger(path.join(tmp, 'log.txt')), (e) => events.push(e), path.join(tmp, 'rec'));
    await service.start({ sessionId: 'live-test02', sources: ['mic'] });
    await service.test();

    const speech = readWav(path.join('tests', 'fixtures', 'question-16k.wav'));
    const question = new Int16Array(speech.length + 16_000 * 1.5);
    question.set(speech);
    expect((await streamAndWait(service, events, question))[0]?.text.toLowerCase()).toContain('java');

    // Loud enough to open a segment, but no words. With the question as prompt, whisper
    // without VAD invents text for this, such as an echo of the question.
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    const noise = new Int16Array(16_000 * 3.7);
    for (let i = 0; i < 16_000 * 2.2; i++) noise[i] = Math.round(rand() * 1300);
    const finals = await streamAndWait(service, events, noise);
    expect(finals.length).toBeGreaterThan(0);
    expect(finals.map((f) => f.text)).toEqual(finals.map(() => ''));
    await service.stop();
  }, 90_000);
});

describe('findModel', () => {
  it('returns undefined for a missing folder', () => {
    expect(findModel(path.join(tmpdir(), 'definitely-missing-folder'))).toBeUndefined();
  });
});
