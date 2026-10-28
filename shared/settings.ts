/**
 * User settings: the model, defaults and a sanitizer. The main process owns the
 * settings file; anything arriving from disk or from the renderer passes through
 * sanitizeSettings() so a malformed value can never reach the OS layer.
 */

export type ResponseLength = 'short' | 'medium' | 'detailed';
/** local: Ollama on this computer. groq: Groq's online API (falls back to local on failure). */
export type AiProvider = 'local' | 'groq';
export type AudioSource = 'mic' | 'system';
export type SttMode = 'managed' | 'external';
export type PositionPreset = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'center';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Settings {
  ollama: {
    /** Base URL of the Ollama HTTP API. */
    endpoint: string;
    /** Installed model name; empty means "first installed model". */
    model: string;
    temperature: number;
  };
  ai: {
    provider: AiProvider;
    /** Groq model id; empty means the app default. The API key is stored separately, encrypted. */
    groqModel: string;
    responseLength: ResponseLength;
    /** Answer automatically when a question is detected in meeting audio. */
    autoAnswer: boolean;
    /** With autoAnswer: also answer lines that are not questions, once the speaker pauses. Fillers are skipped. */
    answerEveryLine: boolean;
    /** Extra instructions appended to every system prompt. */
    customInstructions: string;
  };
  stt: {
    /** managed: the app runs whisper-server itself. external: use an already running server. */
    mode: SttMode;
    serverPath: string;
    modelPath: string;
    externalUrl: string;
    threads: number;
    /** Silence that ends a segment, in milliseconds. */
    silenceMs: number;
    /** Hard cap on a single segment, in seconds. */
    maxSegmentSec: number;
    /** Minimum RMS level (0..1) treated as speech. */
    vadThreshold: number;
    /** Show in-progress (partial) text while someone is still speaking. */
    partials: boolean;
    /** Technical terms sent to whisper as a prompt so it spells them correctly. */
    vocabulary: string;
    micDeviceId: string;
    sources: Record<AudioSource, boolean>;
  };
  overlay: {
    opacity: number;
    alwaysOnTop: boolean;
    /** Ask supported OS capture paths to exclude the window; not guaranteed for every capture API. */
    contentProtection: boolean;
    bounds: Bounds | null;
  };
  shortcuts: {
    toggleWindow: string;
    toggleCapture: string;
    askAi: string;
  };
  privacy: {
    /** Set once the user accepts the in-app capture notice. */
    captureConsent: boolean;
    saveHistory: boolean;
    /** Delete history older than this many days at startup; 0 keeps everything. */
    historyRetentionDays: number;
    /** Write each recognized audio segment to disk as WAV. Off by default. */
    saveAudio: boolean;
  };
  profile: {
    targetRole: string;
    resumeText: string;
  };
}

/** A deep partial used for settings updates from the renderer. */
export type SettingsPatch = {
  [K in keyof Settings]?: Partial<Settings[K]>;
};

export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
export const DEFAULT_WHISPER_URL = 'http://127.0.0.1:8178';
export const MAX_RESUME_CHARS = 20_000;
/** whisper keeps only ~224 prompt tokens. */
export const MAX_VOCABULARY_CHARS = 600;
export const DEFAULT_VOCABULARY =
  'Java, Java 8, Java 11, Java 17, OOP, inheritance, polymorphism, encapsulation, abstraction, interface, ' +
  'abstract class, constructor, overloading, overriding, exception, garbage collection, JVM, Collections, HashMap, ' +
  'ArrayList, Stream API, lambda, functional interface, Optional, default method, method reference, multithreading, ' +
  'Spring Boot, Hibernate, JPA, Maven, JUnit, dependency injection, Angular, TypeScript, JavaScript, RxJS, NgRx, ' +
  'Observable, ngOnInit, REST API, microservices, Kafka, Redis, SQL, MongoDB, Docker, Kubernetes, AWS, CI/CD, Git, ' +
  'SOLID, Big-O.';

export const DEFAULT_SETTINGS: Settings = {
  ollama: { endpoint: DEFAULT_OLLAMA_ENDPOINT, model: '', temperature: 0.4 },
  ai: { provider: 'local', groqModel: '', responseLength: 'medium', autoAnswer: false, answerEveryLine: true, customInstructions: '' },
  stt: {
    mode: 'managed',
    serverPath: '',
    modelPath: '',
    externalUrl: DEFAULT_WHISPER_URL,
    threads: 4,
    silenceMs: 800,
    maxSegmentSec: 15,
    vadThreshold: 0.012,
    partials: true,
    vocabulary: DEFAULT_VOCABULARY,
    micDeviceId: '',
    sources: { mic: true, system: false },
  },
  overlay: { opacity: 1, alwaysOnTop: true, contentProtection: true, bounds: null },
  shortcuts: {
    toggleWindow: 'CommandOrControl+Shift+Space',
    toggleCapture: 'CommandOrControl+Shift+R',
    askAi: 'CommandOrControl+Shift+Enter',
  },
  privacy: { captureConsent: false, saveHistory: true, historyRetentionDays: 30, saveAudio: false },
  profile: { targetRole: '', resumeText: '' },
};

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, fallback: string, max = 500): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Accept only http(s) URLs and normalise away a trailing slash. */
export function sanitizeUrl(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  try {
    const url = new URL(v.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

/** Electron accelerators: modifiers and keys joined by '+'. Real validation happens on registration. */
export function sanitizeAccelerator(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const value = v.trim();
  if (value === '') return '';
  return /^[A-Za-z0-9+\-=,./;'[\]`\\ ]{1,60}$/.test(value) ? value : fallback;
}

function sanitizeBounds(v: unknown): Bounds | null {
  if (!isObj(v)) return null;
  const { x, y, width, height } = v;
  if ([x, y, width, height].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  return {
    x: Math.round(x as number),
    y: Math.round(y as number),
    width: Math.round(num(width, 420, 200, 10_000)),
    height: Math.round(num(height, 640, 200, 10_000)),
  };
}

export function sanitizeSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const s = isObj(input) ? input : {};
  const o = isObj(s['ollama']) ? s['ollama'] : {};
  const ai = isObj(s['ai']) ? s['ai'] : {};
  const stt = isObj(s['stt']) ? s['stt'] : {};
  const sources = isObj(stt['sources']) ? stt['sources'] : {};
  const ov = isObj(s['overlay']) ? s['overlay'] : {};
  const sc = isObj(s['shortcuts']) ? s['shortcuts'] : {};
  const pr = isObj(s['privacy']) ? s['privacy'] : {};
  const pf = isObj(s['profile']) ? s['profile'] : {};

  return {
    ollama: {
      endpoint: sanitizeUrl(o['endpoint'], base.ollama.endpoint),
      model: str(o['model'], base.ollama.model, 200).trim(),
      temperature: num(o['temperature'], base.ollama.temperature, 0, 2),
    },
    ai: {
      provider: oneOf(ai['provider'], ['local', 'groq'] as const, base.ai.provider),
      groqModel: str(ai['groqModel'], base.ai.groqModel, 200).trim(),
      responseLength: oneOf(ai['responseLength'], ['short', 'medium', 'detailed'] as const, base.ai.responseLength),
      autoAnswer: bool(ai['autoAnswer'], base.ai.autoAnswer),
      answerEveryLine: bool(ai['answerEveryLine'], base.ai.answerEveryLine),
      customInstructions: str(ai['customInstructions'], base.ai.customInstructions, 2000),
    },
    stt: {
      mode: oneOf(stt['mode'], ['managed', 'external'] as const, base.stt.mode),
      serverPath: str(stt['serverPath'], base.stt.serverPath, 1000).trim(),
      modelPath: str(stt['modelPath'], base.stt.modelPath, 1000).trim(),
      externalUrl: sanitizeUrl(stt['externalUrl'], base.stt.externalUrl),
      threads: Math.round(num(stt['threads'], base.stt.threads, 1, 32)),
      silenceMs: Math.round(num(stt['silenceMs'], base.stt.silenceMs, 300, 3000)),
      maxSegmentSec: Math.round(num(stt['maxSegmentSec'], base.stt.maxSegmentSec, 5, 30)),
      vadThreshold: num(stt['vadThreshold'], base.stt.vadThreshold, 0.001, 0.2),
      partials: bool(stt['partials'], base.stt.partials),
      vocabulary: str(stt['vocabulary'], base.stt.vocabulary, MAX_VOCABULARY_CHARS),
      micDeviceId: str(stt['micDeviceId'], base.stt.micDeviceId, 200),
      sources: {
        mic: bool(sources['mic'], base.stt.sources.mic),
        system: bool(sources['system'], base.stt.sources.system),
      },
    },
    overlay: {
      opacity: num(ov['opacity'], base.overlay.opacity, 0.3, 1),
      alwaysOnTop: bool(ov['alwaysOnTop'], base.overlay.alwaysOnTop),
      contentProtection: bool(ov['contentProtection'], base.overlay.contentProtection),
      bounds: 'bounds' in ov ? sanitizeBounds(ov['bounds']) : base.overlay.bounds,
    },
    shortcuts: {
      toggleWindow: sanitizeAccelerator(sc['toggleWindow'], base.shortcuts.toggleWindow),
      toggleCapture: sanitizeAccelerator(sc['toggleCapture'], base.shortcuts.toggleCapture),
      askAi: sanitizeAccelerator(sc['askAi'], base.shortcuts.askAi),
    },
    privacy: {
      captureConsent: bool(pr['captureConsent'], base.privacy.captureConsent),
      saveHistory: bool(pr['saveHistory'], base.privacy.saveHistory),
      historyRetentionDays: Math.round(num(pr['historyRetentionDays'], base.privacy.historyRetentionDays, 0, 3650)),
      saveAudio: bool(pr['saveAudio'], base.privacy.saveAudio),
    },
    profile: {
      targetRole: str(pf['targetRole'], base.profile.targetRole, 200),
      resumeText: str(pf['resumeText'], base.profile.resumeText, MAX_RESUME_CHARS),
    },
  };
}

/** Apply a renderer patch on top of the current settings, validating every field. */
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  if (!isObj(patch)) return current;
  const merged: Obj = { ...current };
  for (const key of Object.keys(current) as (keyof Settings)[]) {
    const section = patch[key];
    if (isObj(section)) merged[key] = { ...current[key], ...section };
  }
  // Fields missing from the patch fall back to `current`, not to the defaults.
  return sanitizeSettings(merged, current);
}
