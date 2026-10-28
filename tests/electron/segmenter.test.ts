import { describe, expect, it } from 'vitest';
import { Segmenter, concat, rms } from '../../electron/stt/segmenter';
import { encodeWav } from '../../electron/stt/wav';

const RATE = 16_000;

function tone(ms: number, amplitude = 0.3): Int16Array {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * amplitude * 32767);
  return out;
}

function silence(ms: number, noise = 0.001): Int16Array {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round((Math.random() * 2 - 1) * noise * 32767);
  return out;
}

/** Feed audio in 100 ms chunks, the size the renderer sends. */
function feed(seg: Segmenter, audio: Int16Array) {
  const out = [];
  for (let i = 0; i < audio.length; i += 1600) out.push(...seg.push(audio.slice(i, i + 1600)));
  return out;
}

const make = (overrides = {}) =>
  new Segmenter({ sampleRate: RATE, silenceMs: 800, maxSegmentSec: 15, threshold: 0.012, ...overrides });

describe('Segmenter', () => {
  it('emits one segment per utterance separated by silence', () => {
    const seg = make();
    const out = feed(seg, concat([silence(500), tone(1500), silence(1200), tone(1000), silence(1200)]));
    expect(out).toHaveLength(2);
    // Roughly the speech plus pre-roll and a little trailing silence.
    expect(out[0].samples.length / RATE).toBeGreaterThan(1.5);
    expect(out[0].samples.length / RATE).toBeLessThan(2.3);
  });

  it('does not split on short pauses within a sentence', () => {
    const out = feed(make(), concat([tone(800), silence(300), tone(800), silence(1000)]));
    expect(out).toHaveLength(1);
  });

  it('ignores clicks shorter than the minimum speech length', () => {
    const out = feed(make(), concat([silence(300), tone(100), silence(1500)]));
    expect(out).toHaveLength(0);
  });

  it('splits long monologues at a natural pause after two thirds of the max length', () => {
    const seg = make({ maxSegmentSec: 6 });
    const out = feed(seg, concat([tone(4500), silence(300), tone(2000), silence(1000)]));
    expect(out.length).toBe(2);
    expect(out[0].samples.length / RATE).toBeLessThan(6);
  });

  it('force-splits continuous speech at the max length', () => {
    // Syllable-like bursts with short dips, as in real uninterrupted speech.
    const parts: Int16Array[] = [];
    for (let t = 0; t < 12_000; t += 260) parts.push(tone(200, 0.3), silence(60));
    const out = feed(make({ maxSegmentSec: 5 }), concat(parts));
    expect(out.length).toBe(2);
    expect(out[0].samples.length / RATE).toBeCloseTo(5, 0);
  });

  it('flush() ends an utterance in progress', () => {
    const seg = make();
    feed(seg, concat([silence(200), tone(1200)]));
    expect(seg.speaking).toBe(true);
    expect(seg.current()?.length).toBeGreaterThan(0);
    const flushed = seg.flush();
    expect(flushed).not.toBeNull();
    expect(seg.speaking).toBe(false);
    expect(seg.flush()).toBeNull();
  });

  it('adapts to steady background noise', () => {
    // Noise above the absolute threshold should not count as speech forever.
    const noisy = silence(3000, 0.02);
    const seg = make({ threshold: 0.005 });
    const out = feed(seg, concat([noisy, tone(1000, 0.4), silence(1000, 0.02)]));
    expect(out.length).toBeLessThanOrEqual(2);
    expect(out.some((s) => s.samples.length / RATE > 0.9)).toBe(true);
  });

  it('learns noise that starts mid-session and resumes normal segmentation', () => {
    const seg = make({ threshold: 0.005, maxSegmentSec: 10 });
    // A fan switches on (rms ~0.03): at worst a few junk segments while it adapts...
    const noisy = feed(seg, concat([silence(500), silence(40_000, 0.05)]));
    expect(noisy.length).toBeLessThanOrEqual(5);
    // ...after which speech over the noise is segmented normally again.
    const out = feed(seg, concat([tone(1500, 0.4), silence(1500, 0.05)]));
    expect(out).toHaveLength(1);
    expect(out[0].samples.length / RATE).toBeLessThan(2.5);
  });
});

describe('rms', () => {
  it('is zero for silence and ~0.707*amplitude for a sine', () => {
    expect(rms(new Int16Array(100))).toBe(0);
    expect(rms(tone(100, 0.5))).toBeCloseTo(0.354, 2);
  });
});

describe('encodeWav', () => {
  it('writes a valid 16 kHz mono PCM header', () => {
    const wav = encodeWav(new Int16Array([1, -1, 32767]), RATE);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(RATE);
    expect(wav.readUInt32LE(40)).toBe(6);
    expect(wav.readInt16LE(48)).toBe(32767);
    expect(wav.length).toBe(50);
  });
});
