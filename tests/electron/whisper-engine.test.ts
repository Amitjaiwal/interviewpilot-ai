import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../electron/logger';
import { WhisperEngine, findModel } from '../../electron/stt/whisper-engine';

let dir: string;
const log = { info: () => undefined, warn: () => undefined } as unknown as Logger;
const config = { mode: 'managed' as const, serverPath: '', modelPath: '', externalUrl: '', threads: 4 };

/** Create an empty file under the temp root. */
function touch(...parts: string[]): string {
  const file = path.join(dir, ...parts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
  return file;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ip-engine-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('findModel', () => {
  it('prefers large-v3-turbo, then small.en, and never picks the VAD model', () => {
    touch('models', 'ggml-base.en.bin');
    touch('models', 'ggml-silero-v5.1.2.bin');
    touch('models', 'ggml-small.en.bin');
    expect(path.basename(findModel(path.join(dir, 'models'))!)).toBe('ggml-small.en.bin');
    touch('models', 'ggml-large-v3-turbo-q8_0.bin');
    expect(path.basename(findModel(path.join(dir, 'models'))!)).toBe('ggml-large-v3-turbo-q8_0.bin');
  });
});

describe('WhisperEngine.resolvePaths', () => {
  it('uses the GPU build when it is installed next to the CPU build', () => {
    touch('bin', 'whisper-server.exe');
    touch('models', 'ggml-small.en.bin');
    const vad = touch('models', 'ggml-silero-v5.1.2.bin');
    const engine = new WhisperEngine(log, [dir]);
    expect(engine.resolvePaths(config)).toEqual({
      serverPath: path.join(dir, 'bin', 'whisper-server.exe'),
      modelPath: path.join(dir, 'models', 'ggml-small.en.bin'),
      vadModelPath: vad,
    });
    touch('bin-gpu', 'whisper-server.exe');
    expect(engine.resolvePaths(config).serverPath).toBe(path.join(dir, 'bin-gpu', 'whisper-server.exe'));
  });

  it('keeps a server path set in Settings', () => {
    touch('bin-gpu', 'whisper-server.exe');
    const custom = touch('custom', 'whisper-server.exe');
    const engine = new WhisperEngine(log, [dir]);
    expect(engine.resolvePaths({ ...config, serverPath: custom }).serverPath).toBe(custom);
  });
});
