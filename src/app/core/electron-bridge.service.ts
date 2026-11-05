import { Injectable, NgZone, inject } from '@angular/core';
import type {
  AiEvent,
  AiStatus,
  AppInfo,
  HistorySession,
  InterviewPilotApi,
  ShortcutStatus,
  SttEvent,
  SttStatus,
  WindowState,
} from '../../../shared/ipc';
import { DEFAULT_SETTINGS, Settings, applySettingsPatch } from '../../../shared/settings';

declare global {
  interface Window {
    interviewPilot?: InterviewPilotApi;
  }
}

/**
 * Thin wrapper around the API exposed by the preload script.
 * When the UI runs in a plain browser (ng serve without Electron, unit tests)
 * it falls back to a harmless in-memory implementation.
 */
@Injectable({ providedIn: 'root' })
export class ElectronBridgeService {
  readonly api: InterviewPilotApi = window.interviewPilot ?? createBrowserFallback();
  readonly isElectron = window.interviewPilot !== undefined;
  private readonly zone = inject(NgZone);

  /**
   * IPC callbacks arrive outside Angular's zone; re-enter it so views update.
   * Usage: bridge.listen(bridge.api.ai.onEvent, (e) => ...)
   */
  listen<T>(subscribe: (listener: (payload: T) => void) => () => void, listener: (payload: T) => void): () => void {
    return subscribe((payload) => this.zone.run(() => listener(payload)));
  }
}

function createBrowserFallback(): InterviewPilotApi {
  let state: WindowState = { alwaysOnTop: false, focused: true };
  let settings: Settings = DEFAULT_SETTINGS;
  const info: AppInfo = {
    name: 'InterviewPilot AI',
    version: 'browser',
    platform: 'web',
    electron: '-',
    chrome: '-',
    node: '-',
    toggleShortcut: 'Ctrl+Shift+Space',
  };
  const aiListeners = new Set<(e: AiEvent) => void>();
  const sttStatus: SttStatus = {
    engine: 'error',
    capture: 'idle',
    queue: 0,
    error: 'Speech recognition is only available in the desktop app.',
  };
  const ollama: AiStatus = {
    provider: 'local',
    apiKeySet: false,
    reachable: false,
    endpoint: settings.ollama.endpoint,
    models: [],
    modelMissing: false,
    error: 'Running in a browser: AI features need the desktop app.',
  };
  const shortcuts: ShortcutStatus = {
    toggleWindow: { accelerator: settings.shortcuts.toggleWindow, registered: false },
    toggleCapture: { accelerator: settings.shortcuts.toggleCapture, registered: false },
    askAi: { accelerator: settings.shortcuts.askAi, registered: false },
  };
  let counter = 0;
  const noop = () => () => undefined;

  return {
    getAppInfo: async () => info,
    copyText: async (text) => {
      await navigator.clipboard?.writeText(text).catch(() => undefined);
    },
    openDataFolder: async () => undefined,
    getDiagnostics: async () => ({
      app: info,
      userDataPath: '-',
      settingsPath: '-',
      historyPath: '-',
      logPath: '-',
      ollama,
      stt: sttStatus,
      shortcuts,
    }),
    onShortcut: noop,
    window: {
      minimize: () => undefined,
      hide: () => undefined,
      close: () => undefined,
      getState: async () => state,
      setAlwaysOnTop: async (value) => (state = { ...state, alwaysOnTop: value }),
      setContentProtection: async () => undefined,
      setSize: async () => undefined,
      moveTo: async () => undefined,
      onStateChange: noop,
    },
    settings: {
      get: async () => settings,
      update: async (patch) => (settings = applySettingsPatch(settings, patch)),
      shortcutStatus: async () => shortcuts,
      onChange: noop,
    },
    ai: {
      status: async () => ollama,
      setApiKey: async () => ollama,
      pullRecommendedModel: async () => ollama,
      cancelPull: () => undefined,
      onPullProgress: noop,
      start: async () => {
        const requestId = `browser-${++counter}`;
        setTimeout(() => {
          const event: AiEvent = { requestId, type: 'error', code: 'unreachable', message: ollama.error ?? '' };
          aiListeners.forEach((l) => l(event));
        });
        return requestId;
      },
      cancel: () => undefined,
      onEvent: (listener) => {
        aiListeners.add(listener);
        return () => aiListeners.delete(listener);
      },
    },
    stt: {
      status: async () => sttStatus,
      start: async () => {
        throw new Error(sttStatus.error);
      },
      pause: async () => sttStatus,
      resume: async () => sttStatus,
      stop: async () => sttStatus,
      pushAudio: () => undefined,
      test: async () => sttStatus,
      micAccess: async () => 'unknown',
      onEvent: noop as (listener: (event: SttEvent) => void) => () => void,
    },
    history: {
      list: async () => [],
      get: async (): Promise<HistorySession | null> => null,
      delete: async () => undefined,
      clear: async () => undefined,
    },
  };
}
