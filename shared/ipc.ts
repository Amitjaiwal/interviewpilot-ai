/**
 * Typed IPC contract shared by the Electron main process, the preload script
 * and the Angular renderer. Channel names live here so both sides stay in sync.
 */
import type { AiProvider, AudioSource, PositionPreset, ResponseLength, Settings, SettingsPatch } from './settings';

export const IPC = {
  appInfo: 'app:info',
  appCopy: 'app:copy',
  appOpenDataFolder: 'app:open-data-folder',
  appDiagnostics: 'app:diagnostics',
  appShortcut: 'app:shortcut',

  windowMinimize: 'window:minimize',
  windowHide: 'window:hide',
  windowClose: 'window:close',
  windowGetState: 'window:get-state',
  windowSetAlwaysOnTop: 'window:set-always-on-top',
  windowSetContentProtection: 'window:set-content-protection',
  windowStateChanged: 'window:state-changed',
  windowSetSize: 'window:set-size',
  windowMoveTo: 'window:move-to',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsChanged: 'settings:changed',
  shortcutStatus: 'settings:shortcut-status',

  ollamaStatus: 'ollama:status',
  ollamaPull: 'ollama:pull',
  ollamaPullCancel: 'ollama:pull-cancel',
  ollamaPullProgress: 'ollama:pull-progress',
  aiSetApiKey: 'ai:set-api-key',
  aiStart: 'ai:start',
  aiCancel: 'ai:cancel',
  aiEvent: 'ai:event',

  sttStatus: 'stt:status',
  sttStart: 'stt:start',
  sttPause: 'stt:pause',
  sttResume: 'stt:resume',
  sttStop: 'stt:stop',
  sttAudio: 'stt:audio',
  sttEvent: 'stt:event',
  sttTest: 'stt:test',
  sttMicAccess: 'stt:mic-access',

  historyList: 'history:list',
  historyGet: 'history:get',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  electron: string;
  chrome: string;
  node: string;
  toggleShortcut: string;
}

export interface WindowState {
  alwaysOnTop: boolean;
  focused: boolean;
}

// ---------------------------------------------------------------- Ollama / AI

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  parameterSize?: string;
}

export interface OllamaStatus {
  reachable: boolean;
  endpoint: string;
  version?: string;
  models: OllamaModel[];
  /** The model that requests will use (configured, or first installed). */
  activeModel?: string;
  /** True when a configured model is not installed. */
  modelMissing: boolean;
  error?: string;
  /** Groq refused the API key, as opposed to being unreachable. */
  keyRejected?: boolean;
  /** Local provider: Ollama's program was found on this PC, even if it is not running. */
  installed?: boolean;
}

/** One progress report from Ollama while it downloads a model. */
export interface ModelPullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/**
 * Status of the selected provider. For 'groq', `endpoint` is the API base URL and
 * `models` the models the key can use. The key itself never leaves the main process.
 */
export interface AiStatus extends OllamaStatus {
  provider: AiProvider;
  apiKeySet: boolean;
}

/**
 * answer:   suggest a spoken answer to a question
 * explain:  explain a concept or a transcript excerpt
 * chat:     free-form study chat, uses `messages`
 * evaluate: score a practice answer (`question` + `input` = the user's answer)
 * generate-questions: personalised practice questions from the profile
 */
export type AiMode = 'answer' | 'explain' | 'chat' | 'evaluate' | 'generate-questions';
export type HistoryKind = 'live' | 'chat' | 'practice';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  mode: AiMode;
  input: string;
  /** Recent transcript or other surrounding context. */
  context?: string;
  /** The practice question when mode is 'evaluate'; the topic for 'generate-questions'. */
  question?: string;
  /** Earlier turns for 'chat'. */
  messages?: ChatMessage[];
  length?: ResponseLength;
  /** Where this exchange is recorded in history. */
  sessionId?: string;
  kind?: HistoryKind;
}

export type AiErrorCode = 'unreachable' | 'no-model' | 'model-missing' | 'aborted' | 'http' | 'invalid';

export type AiEvent =
  | { requestId: string; type: 'start'; model: string }
  | { requestId: string; type: 'chunk'; text: string }
  | { requestId: string; type: 'done'; text: string; durationMs: number }
  | { requestId: string; type: 'error'; code: AiErrorCode; message: string };

// --------------------------------------------------------- Speech to text

export type SttEngineState = 'stopped' | 'starting' | 'ready' | 'error';
export type CaptureState = 'idle' | 'recording' | 'paused';

export interface SttStatus {
  engine: SttEngineState;
  capture: CaptureState;
  sessionId?: string;
  /** Segments waiting to be transcribed. */
  queue: number;
  modelPath?: string;
  serverPath?: string;
  url?: string;
  error?: string;
}

export interface SttStartRequest {
  sessionId: string;
  sources: AudioSource[];
}

export type SttEvent =
  | { type: 'status'; status: SttStatus }
  | {
      type: 'partial' | 'final';
      source: AudioSource;
      segmentId: string;
      text: string;
      at: number;
      /** Set on finals that look like a question. */
      question?: boolean;
    }
  | { type: 'error'; message: string };

// --------------------------------------------------------------- History

export interface TranscriptEntry {
  source: AudioSource;
  text: string;
  at: number;
}

export interface ExchangeEntry {
  mode: AiMode;
  prompt: string;
  response: string;
  model: string;
  at: number;
}

export interface HistorySession {
  id: string;
  kind: HistoryKind;
  title: string;
  startedAt: number;
  updatedAt: number;
  transcript: TranscriptEntry[];
  exchanges: ExchangeEntry[];
}

export interface HistorySummary {
  id: string;
  kind: HistoryKind;
  title: string;
  startedAt: number;
  updatedAt: number;
  transcriptCount: number;
  exchangeCount: number;
  /** A short excerpt around the search match, when searching. */
  snippet?: string;
}

// ----------------------------------------------------------- Misc

export type ShortcutAction = 'toggleWindow' | 'toggleCapture' | 'askAi';
export type ShortcutStatus = Record<ShortcutAction, { accelerator: string; registered: boolean; error?: string }>;

export interface Diagnostics {
  app: AppInfo;
  userDataPath: string;
  settingsPath: string;
  historyPath: string;
  logPath: string;
  ollama: AiStatus;
  stt: SttStatus;
  shortcuts: ShortcutStatus;
}

/** API exposed to the renderer as `window.interviewPilot` via contextBridge. */
export interface InterviewPilotApi {
  getAppInfo(): Promise<AppInfo>;
  copyText(text: string): Promise<void>;
  openDataFolder(): Promise<void>;
  getDiagnostics(): Promise<Diagnostics>;
  /** Global shortcuts that the renderer handles (capture, ask AI). */
  onShortcut(listener: (action: ShortcutAction) => void): () => void;

  window: {
    minimize(): void;
    hide(): void;
    close(): void;
    getState(): Promise<WindowState>;
    setAlwaysOnTop(value: boolean): Promise<WindowState>;
    setContentProtection(value: boolean): Promise<void>;
    setSize(width: number, height: number): Promise<void>;
    moveTo(preset: PositionPreset): Promise<void>;
    /** Subscribe to window state changes. Returns an unsubscribe function. */
    onStateChange(listener: (state: WindowState) => void): () => void;
  };

  settings: {
    get(): Promise<Settings>;
    update(patch: SettingsPatch): Promise<Settings>;
    shortcutStatus(): Promise<ShortcutStatus>;
    onChange(listener: (settings: Settings) => void): () => void;
  };

  ai: {
    status(): Promise<AiStatus>;
    /**
     * Store (encrypted) or, with an empty string, remove the Groq API key. Rejects without
     * saving if Groq refuses the key; a key that cannot be checked right now (no internet) is saved.
     */
    setApiKey(key: string): Promise<AiStatus>;
    /** Download the recommended model with Ollama and resolve with the new status; progress arrives via onPullProgress. */
    pullRecommendedModel(): Promise<AiStatus>;
    /** Stop the download. Ollama keeps what it has and resumes from there next time. */
    cancelPull(): void;
    onPullProgress(listener: (progress: ModelPullProgress) => void): () => void;
    /** Starts a streamed request and resolves with its id; output arrives via onEvent. */
    start(request: AiRequest): Promise<string>;
    cancel(requestId: string): void;
    onEvent(listener: (event: AiEvent) => void): () => void;
  };

  stt: {
    status(): Promise<SttStatus>;
    start(request: SttStartRequest): Promise<SttStatus>;
    pause(): Promise<SttStatus>;
    resume(): Promise<SttStatus>;
    stop(): Promise<SttStatus>;
    /** 16 kHz mono signed 16-bit PCM. */
    pushAudio(source: AudioSource, pcm: ArrayBuffer): void;
    /** Start the engine (if needed) and report whether it answers. */
    test(): Promise<SttStatus>;
    /** Whether Windows lets apps use the microphone: 'granted', 'denied', 'restricted', 'not-determined' or 'unknown'. */
    micAccess(): Promise<string>;
    onEvent(listener: (event: SttEvent) => void): () => void;
  };

  history: {
    list(query?: string): Promise<HistorySummary[]>;
    get(id: string): Promise<HistorySession | null>;
    delete(id: string): Promise<void>;
    clear(): Promise<void>;
  };
}
