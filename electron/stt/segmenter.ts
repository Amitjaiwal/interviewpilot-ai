/**
 * Energy-based voice activity segmentation for 16 kHz mono PCM.
 *
 * Audio arrives in small chunks. The segmenter groups it into utterances: a
 * segment starts when speech is detected (keeping a short pre-roll so the
 * first syllable is not clipped) and ends after `silenceMs` of quiet. Long
 * monologues are split at the first natural pause after two thirds of
 * `maxSegmentSec`, or forcibly at `maxSegmentSec`, so transcripts keep flowing.
 */

export interface SegmenterOptions {
  sampleRate: number;
  silenceMs: number;
  maxSegmentSec: number;
  /** Absolute RMS level (0..1) below which audio is never treated as speech. */
  threshold: number;
  /** Segments with less speech than this are discarded as clicks or noise. */
  minSpeechMs?: number;
  preRollMs?: number;
  frameMs?: number;
}

export interface Segment {
  samples: Int16Array;
  speechMs: number;
  /** Sample index just after the last speech frame; the rest is trailing silence. */
  speechEnd: number;
}

export class Segmenter {
  private readonly frameSize: number;
  private readonly frameMs: number;
  private readonly preRollFrames: number;
  private readonly minSpeechMs: number;

  private pending = new Int16Array(0);
  private preRoll: Int16Array[] = [];
  private frames: Int16Array[] = [];
  private inSpeech = false;
  private onsetFrames = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private noiseFloor = 0;

  constructor(private readonly opts: SegmenterOptions) {
    this.frameMs = opts.frameMs ?? 20;
    this.frameSize = Math.round((opts.sampleRate * this.frameMs) / 1000);
    this.preRollFrames = Math.round((opts.preRollMs ?? 300) / this.frameMs);
    this.minSpeechMs = opts.minSpeechMs ?? 250;
  }

  /** True while an utterance is in progress. */
  get speaking(): boolean {
    return this.inSpeech;
  }

  /** Duration of the in-progress utterance in milliseconds. */
  get currentMs(): number {
    return this.frames.length * this.frameMs;
  }

  /** Speech (not silence) in the in-progress utterance, in milliseconds. */
  get currentSpeechMs(): number {
    return this.inSpeech ? this.speechMs : 0;
  }

  /** Silence since the last speech frame of the in-progress utterance, in milliseconds. */
  get silentMs(): number {
    return this.inSpeech ? this.silenceMs : 0;
  }

  /** Copy of the in-progress utterance, for partial transcription. */
  current(): Int16Array | null {
    return this.inSpeech ? concat(this.frames) : null;
  }

  /** Feed audio; returns any segments completed by it. */
  push(chunk: Int16Array): Segment[] {
    const data = this.pending.length ? concat([this.pending, chunk]) : chunk;
    const done: Segment[] = [];
    let offset = 0;
    for (; offset + this.frameSize <= data.length; offset += this.frameSize) {
      const seg = this.processFrame(data.slice(offset, offset + this.frameSize));
      if (seg) done.push(seg);
    }
    this.pending = data.slice(offset);
    return done;
  }

  /** End the current utterance now (pause/stop). */
  flush(): Segment | null {
    this.pending = new Int16Array(0);
    if (!this.inSpeech) return null;
    return this.finish(0);
  }

  private processFrame(frame: Int16Array): Segment | null {
    const level = rms(frame);
    this.trackNoise(level);
    const isSpeech = level > Math.max(this.opts.threshold, this.noiseFloor * 2.5);

    if (!this.inSpeech) {
      this.preRoll.push(frame);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      this.onsetFrames = isSpeech ? this.onsetFrames + 1 : 0;
      // Require 3 consecutive loud frames (60 ms) so a single click does not open a segment.
      if (this.onsetFrames >= 3) {
        this.inSpeech = true;
        this.frames = this.preRoll;
        this.preRoll = [];
        this.speechMs = this.onsetFrames * this.frameMs;
        this.silenceMs = 0;
      }
      return null;
    }

    this.frames.push(frame);
    if (isSpeech) {
      this.speechMs += this.frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += this.frameMs;
    }

    const durationMs = this.currentMs;
    const maxMs = this.opts.maxSegmentSec * 1000;
    if (this.silenceMs >= this.opts.silenceMs) return this.finish(this.silenceMs);
    if (durationMs >= maxMs * 0.66 && this.silenceMs >= 250) return this.finish(this.silenceMs);
    if (durationMs >= maxMs) return this.finish(0);
    return null;
  }

  /**
   * Background-noise estimate: falls quickly to quiet frames (the gaps between
   * words) and rises slowly (~10 s time constant), so a fan or hum that starts
   * mid-session is learned without mistaking normal speech for noise.
   */
  private trackNoise(level: number): void {
    // Never start above the threshold: capture may begin mid-sentence (e.g. meeting audio).
    if (this.noiseFloor === 0) this.noiseFloor = Math.min(level, this.opts.threshold);
    else if (level < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.8 + level * 0.2;
    else this.noiseFloor += (level - this.noiseFloor) * 0.002;
  }

  private finish(trailingSilenceMs: number): Segment | null {
    // Keep ~200 ms of the trailing silence; whisper handles a little padding well.
    const dropFrames = Math.max(0, Math.floor((trailingSilenceMs - 200) / this.frameMs));
    const kept = this.frames.slice(0, this.frames.length - dropFrames);
    const speechEnd = (this.frames.length - Math.round(this.silenceMs / this.frameMs)) * this.frameSize;
    const speechMs = this.speechMs;

    this.inSpeech = false;
    this.frames = [];
    this.onsetFrames = 0;
    this.speechMs = 0;
    this.silenceMs = 0;

    if (speechMs < this.minSpeechMs || kept.length === 0) return null;
    return { samples: concat(kept), speechMs, speechEnd };
  }
}

export function rms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

export function concat(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
