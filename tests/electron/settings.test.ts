import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  sanitizeAccelerator,
  sanitizeSettings,
  sanitizeUrl,
} from '../../shared/settings';

describe('sanitizeSettings', () => {
  it('returns defaults for garbage input', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ ollama: 42, stt: [] })).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps numbers into their allowed ranges', () => {
    const s = sanitizeSettings({ overlay: { opacity: 0 }, stt: { threads: 999, silenceMs: 1 }, ollama: { temperature: -3 } });
    expect(s.overlay.opacity).toBe(0.3);
    expect(s.stt.threads).toBe(32);
    expect(s.stt.silenceMs).toBe(300);
    expect(s.ollama.temperature).toBe(0);
  });

  it('rejects unknown enum values', () => {
    const s = sanitizeSettings({ ai: { responseLength: 'huge' }, stt: { mode: 'cloud' } });
    expect(s.ai.responseLength).toBe('medium');
    expect(s.stt.mode).toBe('managed');
  });

  it('accepts valid bounds and drops malformed ones', () => {
    expect(sanitizeSettings({ overlay: { bounds: { x: 1.4, y: 2, width: 500, height: 700 } } }).overlay.bounds).toEqual({
      x: 1,
      y: 2,
      width: 500,
      height: 700,
    });
    expect(sanitizeSettings({ overlay: { bounds: { x: 'a' } } }).overlay.bounds).toBeNull();
  });

  it('caps the resume length', () => {
    const s = sanitizeSettings({ profile: { resumeText: 'x'.repeat(50_000) } });
    expect(s.profile.resumeText.length).toBe(20_000);
  });
});

describe('sanitizeUrl', () => {
  it('accepts http and https and strips trailing slashes', () => {
    expect(sanitizeUrl('http://localhost:11434/', 'f')).toBe('http://localhost:11434');
    expect(sanitizeUrl(' https://example.com ', 'f')).toBe('https://example.com');
  });

  it('rejects other schemes and junk', () => {
    expect(sanitizeUrl('file:///C:/Windows', 'f')).toBe('f');
    expect(sanitizeUrl('javascript:alert(1)', 'f')).toBe('f');
    expect(sanitizeUrl('not a url', 'f')).toBe('f');
  });
});

describe('sanitizeAccelerator', () => {
  it('keeps plausible accelerators and allows clearing', () => {
    expect(sanitizeAccelerator('CommandOrControl+Shift+K', 'f')).toBe('CommandOrControl+Shift+K');
    expect(sanitizeAccelerator('', 'f')).toBe('');
  });

  it('rejects strings with unexpected characters', () => {
    expect(sanitizeAccelerator('Ctrl+<script>', 'f')).toBe('f');
  });
});

describe('applySettingsPatch', () => {
  it('changes only the patched fields', () => {
    const current = sanitizeSettings({ ollama: { model: 'llama3' }, ai: { responseLength: 'short' } });
    // Answering every line is on by default and only matters with auto-answer.
    expect(current.ai.answerEveryLine).toBe(true);
    const next = applySettingsPatch(current, { ai: { autoAnswer: true, answerEveryLine: false } });
    expect(next.ai.autoAnswer).toBe(true);
    expect(next.ai.answerEveryLine).toBe(false);
    expect(next.ai.responseLength).toBe('short');
    expect(next.ollama.model).toBe('llama3');
  });

  it('keeps the current value when a patched field is invalid', () => {
    const current = sanitizeSettings({ ollama: { endpoint: 'http://10.0.0.5:11434' } });
    const next = applySettingsPatch(current, { ollama: { endpoint: 'ftp://x' } });
    expect(next.ollama.endpoint).toBe('http://10.0.0.5:11434');
  });

  it('merges nested source toggles', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { stt: { sources: { mic: false, system: true } } });
    expect(next.stt.sources).toEqual({ mic: false, system: true });
    expect(next.stt.silenceMs).toBe(DEFAULT_SETTINGS.stt.silenceMs);
  });

  it('ignores non-object patches', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, 'x')).toBe(DEFAULT_SETTINGS);
  });
});
