import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import * as path from 'node:path';
import type { SttEngineState } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import type { Logger } from '../logger';

type SttConfig = Pick<Settings['stt'], 'mode' | 'serverPath' | 'modelPath' | 'externalUrl' | 'threads'>;

export interface EngineSnapshot {
  state: SttEngineState;
  url?: string;
  serverPath?: string;
  modelPath?: string;
  error?: string;
}

export interface TranscribeOptions {
  /** Greedy decoding without fallback: for partials that are replaced moments later. */
  fast?: boolean;
  /** Length of the audio; lets the encoder skip the padding up to whisper's 30 s window. */
  audioSec?: number;
}

/**
 * Encoder context for a clip: 50 positions per second plus 2 s of headroom.
 * whisper always encodes 30 s (1500 positions) by default, so for typical 3-10 s
 * utterances this cuts inference time by 2-3x with the same transcript.
 */
export function audioContext(seconds: number): number {
  return Math.min(1500, Math.max(320, Math.ceil((seconds + 2) * 50)));
}

const STARTUP_TIMEOUT_MS = 60_000;
const INFERENCE_TIMEOUT_MS = 60_000;
const SERVER_EXE = 'whisper-server.exe';

/**
 * Runs whisper.cpp's HTTP server as a child process (managed mode) or talks to
 * one the user already runs (external mode). Audio is posted from memory; the
 * engine never writes it to disk.
 */
export class WhisperEngine {
  private proc: ChildProcess | null = null;
  private snapshot: EngineSnapshot = { state: 'stopped' };
  private configKey = '';
  private starting: Promise<void> | null = null;
  private readonly listeners = new Set<(s: EngineSnapshot) => void>();

  constructor(
    private readonly log: Logger,
    /** Folders searched for whisper-server.exe and ggml models when no path is configured. */
    private readonly searchRoots: string[],
  ) {}

  get status(): EngineSnapshot {
    return this.snapshot;
  }

  onChange(listener: (s: EngineSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start (or restart after a config change) and wait until the server answers. */
  ensureReady(config: SttConfig): Promise<void> {
    // Only engine fields matter; callers may pass the whole stt settings object.
    const { mode, serverPath, modelPath, externalUrl, threads } = config;
    const key = JSON.stringify({ mode, serverPath, modelPath, externalUrl, threads });
    if (key !== this.configKey) {
      this.stop();
      this.configKey = key;
    }
    if (this.snapshot.state === 'ready') return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start(config).finally(() => (this.starting = null));
    }
    return this.starting;
  }

  async transcribe(wav: Buffer, prompt: string, opts: TranscribeOptions = {}): Promise<string> {
    const url = this.snapshot.url;
    if (this.snapshot.state !== 'ready' || !url) throw new Error('Speech engine is not running');
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    // Temperature fallback re-decodes unclear audio; worth it for finals, too slow for previews.
    form.append('temperature_inc', opts.fast ? '0.0' : '0.2');
    if (!opts.fast) form.append('beam_size', '5');
    if (opts.audioSec) form.append('audio_ctx', String(audioContext(opts.audioSec)));
    if (prompt) form.append('prompt', prompt);
    const res = await fetch(`${url}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Speech engine returned HTTP ${res.status}`);
    const body = (await res.json()) as { text?: string; error?: string };
    if (body.error) throw new Error(body.error);
    return body.text ?? '';
  }

  stop(): void {
    this.configKey = '';
    if (this.proc) {
      this.proc.removeAllListeners('exit');
      this.proc.kill();
      this.proc = null;
      this.log.info('whisper', 'server stopped');
    }
    this.set({ state: 'stopped' });
  }

  /** Locate whisper-server.exe, a model and the optional VAD model, honouring configured paths first. */
  resolvePaths(config: SttConfig): { serverPath?: string; modelPath?: string; vadModelPath?: string } {
    const isFile = (p: string) => !!p && existsSync(p) && statSync(p).isFile();
    let serverPath = isFile(config.serverPath) ? config.serverPath : undefined;
    let modelPath = isFile(config.modelPath) ? config.modelPath : undefined;
    let vadModelPath = modelPath ? findVadModel(path.dirname(modelPath)) : undefined;
    for (const root of this.searchRoots) {
      // The CUDA build from "npm run setup:whisper -- --gpu" wins over the CPU build next to it.
      serverPath ??= [path.join(root, 'bin-gpu', SERVER_EXE), path.join(root, 'bin', SERVER_EXE), path.join(root, SERVER_EXE)].find(isFile);
      modelPath ??= findModel(path.join(root, 'models'));
      vadModelPath ??= findVadModel(path.join(root, 'models'));
    }
    return { serverPath, modelPath, vadModelPath };
  }

  private async start(config: SttConfig): Promise<void> {
    if (config.mode === 'external') {
      this.set({ state: 'starting', url: config.externalUrl });
      if (await isReachable(config.externalUrl)) {
        this.set({ state: 'ready', url: config.externalUrl });
        return;
      }
      return this.fail(`No whisper server answered at ${config.externalUrl}. Start it, or switch to managed mode.`);
    }

    const { serverPath, modelPath, vadModelPath } = this.resolvePaths(config);
    if (config.serverPath && serverPath !== config.serverPath) {
      return this.fail(`whisper-server not found at ${config.serverPath}`);
    }
    if (config.modelPath && modelPath !== config.modelPath) {
      return this.fail(`Whisper model not found at ${config.modelPath}`);
    }
    if (!serverPath) {
      return this.fail('whisper.cpp is not installed. Run "npm run setup:whisper" or set the server path in Settings.');
    }
    if (!modelPath) {
      return this.fail('No whisper model (ggml-*.bin) found. Run "npm run setup:whisper" or set the model path in Settings.');
    }

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    this.set({ state: 'starting', url, serverPath, modelPath });

    const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-t', String(config.threads), '-l', 'en', '-sns', '-nt'];
    // Silero VAD: audio without speech (breathing, typing, a fan) is skipped instead of
    // transcribed, which is where whisper invents text such as an echo of the last question.
    if (vadModelPath) args.push('--vad', '-vm', vadModelPath);
    this.log.info(
      'whisper',
      `starting ${serverPath} with model ${path.basename(modelPath)}${vadModelPath ? ` and VAD ${path.basename(vadModelPath)}` : ' (no VAD model)'} on port ${port}`,
    );

    const stderrTail: string[] = [];
    const proc = spawn(serverPath, args, { cwd: path.dirname(serverPath), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    // stderr carries load progress and errors. Kept in memory only, for error messages.
    proc.stderr?.on('data', (d: Buffer) => {
      stderrTail.push(...d.toString().split(/\r?\n/).filter(Boolean));
      stderrTail.splice(0, Math.max(0, stderrTail.length - 15));
    });
    let exited = false;
    proc.on('error', () => (exited = true));
    proc.on('exit', (code) => {
      exited = true;
      if (this.proc === proc) {
        this.proc = null;
        this.configKey = '';
        this.log.warn('whisper', `server exited with code ${code}`);
        this.fail(`Speech engine stopped unexpectedly (exit code ${code}).`);
      }
    });

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) {
        const detail = stderrTail.slice(-3).join(' | ');
        return this.fail(`Speech engine failed to start${detail ? `: ${detail}` : ''}`);
      }
      if (await isReachable(url)) {
        this.log.info('whisper', 'server ready');
        this.set({ state: 'ready', url, serverPath, modelPath });
        return;
      }
      await delay(300);
    }
    this.stop();
    return this.fail('Speech engine did not start within 60 seconds.');
  }

  private fail(error: string): void {
    this.log.warn('whisper', error);
    this.set({ ...this.snapshot, state: 'error', error });
  }

  private set(snapshot: EngineSnapshot): void {
    this.snapshot = snapshot;
    for (const l of this.listeners) l(snapshot);
  }
}

/**
 * Prefer the most accurate model installed. large-v3-turbo comes first: it copes
 * best with accents and technical terms, and is fast with the GPU build. Then
 * English models, small.en first: it recognises technical terms far better than
 * base.en and is still fast enough for live use on a CPU.
 */
export function findModel(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const models = readdirSync(dir).filter((f) => /^ggml-.*\.bin$/i.test(f) && !/silero|vad/i.test(f));
  const rank = (f: string) => {
    const order = [
      'large-v3-turbo', 'large-v3-turbo-q8_0', 'large-v3-turbo-q5_0',
      'small.en', 'base.en', 'tiny.en', 'small', 'base', 'tiny', 'medium.en', 'medium',
    ];
    const i = order.findIndex((m) => f.toLowerCase() === `ggml-${m}.bin`);
    return i === -1 ? order.length : i;
  };
  models.sort((a, b) => rank(a) - rank(b));
  return models[0] ? path.join(dir, models[0]) : undefined;
}

/** The Silero voice-activity model (ggml-silero-*.bin), newest version first. */
export function findVadModel(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const models = readdirSync(dir)
    .filter((f) => /^ggml-silero.*\.bin$/i.test(f))
    .sort()
    .reverse();
  return models[0] ? path.join(dir, models[0]) : undefined;
}

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    // Older servers have no /health route; any HTTP answer except 503 (still loading) means it is up.
    return res.status !== 503;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
