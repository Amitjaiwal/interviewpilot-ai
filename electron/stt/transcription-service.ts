import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { CaptureState, SttEvent, SttStartRequest, SttStatus } from '../../shared/ipc';
import type { AudioSource, Settings } from '../../shared/settings';
import { cleanTranscript, looksLikeQuestion, removeOverlap, vocabularyTerms } from '../../shared/text';
import type { HistoryStore } from '../history-store';
import type { Logger } from '../logger';
import { Segment, Segmenter } from './segmenter';
import { encodeWav } from './wav';
import type { WhisperEngine } from './whisper-engine';

export const SAMPLE_RATE = 16_000;

/** Minimum gap between partial transcriptions of the same utterance. */
const PARTIAL_INTERVAL_MS = 1200;
const MIN_PARTIAL_MS = 1000;
/** Pause after which the utterance so far is transcribed in final quality, in case the speaker is done. */
const SPECULATE_AFTER_MS = 250;
const MAX_QUEUE = 40;

interface Job {
  /** Mutable: a speculative partial is promoted to 'final' when its pause ends the utterance. */
  kind: 'partial' | 'final';
  speculative?: boolean;
  source: AudioSource;
  segmentId: string;
  samples: Int16Array;
}

interface SourceState {
  segmenter: Segmenter;
  segmentId: string | null;
  lastPartialAt: number;
  lastFinal: string;
  /** Latest speculative job of the current utterance and, once done, its raw text. */
  speculation: { job: Job; raw?: string } | null;
}

/**
 * Turns streamed PCM from the renderer into transcript events. One segmenter
 * per audio source; one shared queue so the whisper server handles a single
 * request at a time. Finals always run; partials are skipped when busy.
 *
 * Latency: when the speaker pauses, the utterance is transcribed at once in
 * final quality. If the pause turns out to end the utterance, that result is
 * the final, so it is ready about when the silence timeout fires instead of a
 * full inference later.
 */
export class TranscriptionService {
  private capture: CaptureState = 'idle';
  private sessionId?: string;
  private sources = new Map<AudioSource, SourceState>();
  private queue: Job[] = [];
  private busy = false;
  private counter = 0;
  private readonly finalized = new Set<string>();

  constructor(
    private readonly engine: WhisperEngine,
    private readonly settings: () => Settings,
    private readonly history: HistoryStore,
    private readonly log: Logger,
    private readonly emit: (event: SttEvent) => void,
    private readonly recordingsDir: string,
  ) {
    engine.onChange(() => this.emitStatus());
  }

  get captureState(): CaptureState {
    return this.capture;
  }

  /** Sources currently allowed to capture; used by the permission handlers. */
  isCapturing(source: AudioSource): boolean {
    return this.capture !== 'idle' && this.sources.has(source);
  }

  status(): SttStatus {
    const e = this.engine.status;
    return {
      engine: e.state,
      capture: this.capture,
      sessionId: this.sessionId,
      queue: this.queue.filter((j) => j.kind === 'final').length,
      url: e.url,
      serverPath: e.serverPath,
      modelPath: e.modelPath,
      error: e.error,
    };
  }

  async start(req: SttStartRequest): Promise<SttStatus> {
    const s = this.settings();
    if (this.capture !== 'idle') await this.stop();
    this.sessionId = req.sessionId;
    this.sources.clear();
    for (const source of req.sources) {
      this.sources.set(source, {
        segmenter: new Segmenter({
          sampleRate: SAMPLE_RATE,
          silenceMs: s.stt.silenceMs,
          maxSegmentSec: s.stt.maxSegmentSec,
          threshold: s.stt.vadThreshold,
        }),
        segmentId: null,
        lastPartialAt: 0,
        lastFinal: '',
        speculation: null,
      });
    }
    // Capture starts immediately so no speech is lost while the model loads;
    // segments queue up and are transcribed once the engine is ready.
    this.capture = 'recording';
    this.log.info('stt', `capture started (${req.sources.join(', ')})`);
    this.emitStatus();
    const sessionId = req.sessionId;
    void this.engine.ensureReady(s.stt).then(() => {
      if (this.engine.status.state === 'ready') {
        void this.pump();
        return;
      }
      // Nothing can be transcribed: release the devices instead of recording into a void.
      if (this.capture !== 'idle' && this.sessionId === sessionId) {
        this.queue = [];
        void this.stop();
      }
    });
    return this.status();
  }

  pause(): SttStatus {
    if (this.capture === 'recording') {
      this.flushAll();
      this.capture = 'paused';
      this.emitStatus();
    }
    return this.status();
  }

  resume(): SttStatus {
    if (this.capture === 'paused') {
      this.capture = 'recording';
      this.emitStatus();
    }
    return this.status();
  }

  async stop(): Promise<SttStatus> {
    if (this.capture !== 'idle') {
      this.flushAll();
      this.capture = 'idle';
      this.sources.clear();
      this.log.info('stt', 'capture stopped');
      this.emitStatus();
    }
    return this.status();
  }

  /** Start the engine without capturing, to verify the configuration. */
  async test(): Promise<SttStatus> {
    await this.engine.ensureReady(this.settings().stt);
    return this.status();
  }

  pushAudio(source: AudioSource, pcm: Int16Array): void {
    if (this.capture !== 'recording') return;
    const state = this.sources.get(source);
    if (!state) return;

    const wasSpeaking = state.segmenter.speaking;
    const segments = state.segmenter.push(pcm);
    for (const seg of segments) this.enqueueFinal(source, state, seg);

    if (state.segmenter.speaking) {
      if (!wasSpeaking || !state.segmentId) state.segmentId = this.nextId(source);
      this.maybePartial(source, state);
    }
  }

  private nextId(source: AudioSource): string {
    return `${source}-${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
  }

  private enqueueFinal(source: AudioSource, state: SourceState, seg: Segment): void {
    const segmentId = state.segmentId ?? this.nextId(source);
    const spec = state.speculation;
    state.segmentId = null;
    state.lastPartialAt = 0;
    state.speculation = null;
    // A pending partial for this utterance is now pointless.
    this.queue = this.queue.filter((j) => j.segmentId !== segmentId || j === spec?.job);
    this.saveAudio(segmentId, seg.samples);

    // The speculation already covers every word of the utterance: use it as the final.
    if (spec && spec.job.segmentId === segmentId && spec.job.samples.length >= seg.speechEnd) {
      spec.job.kind = 'final';
      if (spec.raw !== undefined) this.finalize(spec.job, spec.raw);
      this.emitStatus();
      return;
    }

    this.queue.push({ kind: 'final', source, segmentId, samples: seg.samples });
    // If the engine is down, do not let audio pile up in memory indefinitely.
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    this.emitStatus();
    void this.pump();
  }

  private maybePartial(source: AudioSource, state: SourceState): void {
    if (!state.segmentId) return;
    if (this.busy || this.queue.length > 0 || this.engine.status.state !== 'ready') return;
    const seg = state.segmenter;
    if (seg.silentMs >= SPECULATE_AFTER_MS) return this.speculate(source, state);
    if (!this.settings().stt.partials) return;
    const now = Date.now();
    if (seg.currentMs < MIN_PARTIAL_MS || now - state.lastPartialAt < PARTIAL_INTERVAL_MS) return;
    const samples = seg.current();
    if (!samples) return;
    state.lastPartialAt = now;
    this.queue.push({ kind: 'partial', source, segmentId: state.segmentId, samples });
    void this.pump();
  }

  /** Transcribe everything said before the current pause, once per pause. */
  private speculate(source: AudioSource, state: SourceState): void {
    const seg = state.segmenter;
    if (!state.segmentId || seg.currentSpeechMs < 300) return;
    const pauseStart = ((seg.currentMs - seg.silentMs) * SAMPLE_RATE) / 1000;
    const prev = state.speculation?.job;
    if (prev && prev.segmentId === state.segmentId && prev.samples.length >= pauseStart) return;
    const samples = seg.current();
    if (!samples) return;
    const job: Job = { kind: 'partial', speculative: true, source, segmentId: state.segmentId, samples };
    state.speculation = { job };
    state.lastPartialAt = Date.now();
    this.queue.push(job);
    void this.pump();
  }

  private flushAll(): void {
    for (const [source, state] of this.sources) {
      const seg = state.segmenter.flush();
      if (seg) this.enqueueFinal(source, state, seg);
    }
  }

  private async pump(): Promise<void> {
    if (this.busy || this.engine.status.state !== 'ready') return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    try {
      await this.run(job);
    } catch (err) {
      if (job.kind === 'final') {
        this.log.error('stt', 'transcription failed', err);
        this.emit({ type: 'error', message: `Transcription failed: ${err instanceof Error ? err.message : String(err)}` });
        // Clear any partial the UI is showing for this segment.
        this.emit({ type: 'final', source: job.source, segmentId: job.segmentId, text: '', at: Date.now() });
      } else if (job.speculative) {
        // A failed speculation must not stand in for the final.
        const state = this.sources.get(job.source);
        if (state?.speculation?.job === job) state.speculation = null;
      }
    } finally {
      this.busy = false;
      if (job.kind === 'final') this.emitStatus();
      void this.pump();
    }
  }

  private async run(job: Job): Promise<void> {
    const state = this.sources.get(job.source);
    // The vocabulary teaches whisper how technical terms are spelled. The previous
    // sentence is deliberately not sent: on unclear audio whisper copies it instead of
    // transcribing, and that copy becomes the next prompt, so one line keeps repeating.
    const prompt = this.settings().stt.vocabulary.trim();
    const raw = await this.engine.transcribe(encodeWav(job.samples, SAMPLE_RATE), prompt, {
      fast: job.kind === 'partial' && !job.speculative,
      audioSec: job.samples.length / SAMPLE_RATE,
    });

    // Re-read: the utterance may have ended while a speculation was running.
    if (job.kind === 'final') return this.finalize(job, raw);
    if (job.speculative && state?.speculation?.job === job) state.speculation.raw = raw;
    const text = cleanTranscript(raw);
    if (!this.settings().stt.partials || this.finalized.has(job.segmentId) || !text) return;
    this.emit({ type: 'partial', source: job.source, segmentId: job.segmentId, text, at: Date.now() });
  }

  private finalize(job: Job, raw: string): void {
    const state = this.sources.get(job.source);
    const text = removeOverlap(state?.lastFinal ?? '', cleanTranscript(raw));
    this.finalized.add(job.segmentId);
    if (this.finalized.size > 500) this.finalized.delete(this.finalized.values().next().value as string);
    const at = Date.now();
    const question = text ? looksLikeQuestion(text, vocabularyTerms(this.settings().stt.vocabulary)) : false;
    this.emit({ type: 'final', source: job.source, segmentId: job.segmentId, text, at, question });
    if (!text) return;
    if (state) state.lastFinal = text;
    if (this.sessionId && this.settings().privacy.saveHistory) {
      this.history.appendTranscript(this.sessionId, { source: job.source, text, at });
    }
  }

  private saveAudio(segmentId: string, samples: Int16Array): void {
    if (!this.settings().privacy.saveAudio || !this.sessionId) return;
    try {
      const dir = path.join(this.recordingsDir, this.sessionId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${segmentId}.wav`), encodeWav(samples, SAMPLE_RATE));
    } catch (err) {
      this.log.error('stt', 'could not save audio segment', err);
    }
  }

  private emitStatus(): void {
    this.emit({ type: 'status', status: this.status() });
  }
}
