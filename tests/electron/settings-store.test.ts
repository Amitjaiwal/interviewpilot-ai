import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../../electron/settings-store';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ip-settings-'));
  file = path.join(dir, 'settings.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a new installation', () => {
  it('starts on Groq with setup still to do, saved at once', () => {
    const s = new SettingsStore(file).startNewInstall();
    expect(s.ai.provider).toBe('groq');
    expect(s.setup.onboardingDone).toBe(false);
    expect(s.ollama.endpoint).toBe('http://127.0.0.1:11434');
    expect(JSON.parse(readFileSync(file, 'utf8')).ai.provider).toBe('groq');
  });

  it('still needs setup after quitting halfway', () => {
    new SettingsStore(file).startNewInstall();
    const next = new SettingsStore(file).load();
    expect(next.ai.provider).toBe('groq');
    expect(next.setup.onboardingDone).toBe(false);
  });

  it('stays finished once setup is done', () => {
    const first = new SettingsStore(file);
    first.startNewInstall();
    first.update({ setup: { onboardingDone: true } });
    expect(new SettingsStore(file).load().setup.onboardingDone).toBe(true);
  });
});

describe('upgrading an existing installation', () => {
  it('keeps a Groq user on Groq and skips setup', () => {
    writeFileSync(file, JSON.stringify({ ai: { provider: 'groq', groqModel: 'openai/gpt-oss-20b' }, profile: { targetRole: 'Java dev' } }));
    const s = new SettingsStore(file).load();
    expect(s.ai.provider).toBe('groq');
    expect(s.ai.groqModel).toBe('openai/gpt-oss-20b');
    expect(s.profile.targetRole).toBe('Java dev');
    expect(s.setup.onboardingDone).toBe(true);
  });

  it('keeps an Ollama user on Ollama and skips setup', () => {
    writeFileSync(file, JSON.stringify({ ai: { provider: 'local' }, ollama: { model: 'qwen3:8b' } }));
    const s = new SettingsStore(file).load();
    expect(s.ai.provider).toBe('local');
    expect(s.ollama.model).toBe('qwen3:8b');
    expect(s.setup.onboardingDone).toBe(true);
  });

  it('never moves settings from before Groq existed onto Groq', () => {
    writeFileSync(file, JSON.stringify({ ollama: { model: 'qwen2.5:7b' }, privacy: { captureConsent: true } }));
    const s = new SettingsStore(file).load();
    expect(s.ai.provider).toBe('local');
    expect(s.privacy.captureConsent).toBe(true);
    expect(s.setup.onboardingDone).toBe(true);
  });

  it('never moves someone who never changed a setting onto Groq', () => {
    // No settings file, but main.ts saw their log folder, so it calls load() and not startNewInstall().
    const s = new SettingsStore(file).load();
    expect(s.ai.provider).toBe('local');
    expect(s.setup.onboardingDone).toBe(true);
  });

  it('never moves someone with a damaged settings file onto Groq', () => {
    writeFileSync(file, '{ not json');
    const s = new SettingsStore(file).load();
    expect(s.ai.provider).toBe('local');
    expect(s.setup.onboardingDone).toBe(true);
  });
});
