import type { AiEvent, InterviewPilotApi, ShortcutAction, SttEvent, WindowState } from '../../../shared/ipc';
import { DEFAULT_SETTINGS, Settings, applySettingsPatch } from '../../../shared/settings';

/** A scriptable in-memory InterviewPilotApi for component and service tests. */
export function createFakeApi() {
  let state: WindowState = { alwaysOnTop: true, focused: true };
  let settings: Settings = DEFAULT_SETTINGS;
  const calls: string[] = [];
  const ai = new Set<(e: AiEvent) => void>();
  const stt = new Set<(e: SttEvent) => void>();
  const shortcuts = new Set<(a: ShortcutAction) => void>();
  const aiRequests: unknown[] = [];

  const api: InterviewPilotApi = {
    getAppInfo: async () => ({
      name: 'InterviewPilot AI',
      version: '1.2.3',
      platform: 'win32',
      electron: '33.2.1',
      chrome: '130',
      node: '20',
      toggleShortcut: 'CommandOrControl+Shift+Space',
    }),
    copyText: async (text) => {
      calls.push(`copy:${text}`);
    },
    openDataFolder: async () => undefined,
    getDiagnostics: async () => {
      throw new Error('not used');
    },
    onShortcut: (l) => {
      shortcuts.add(l);
      return () => shortcuts.delete(l);
    },
    window: {
      minimize: () => calls.push('minimize'),
      hide: () => calls.push('hide'),
      close: () => calls.push('close'),
      getState: async () => state,
      setAlwaysOnTop: async (value) => (state = { ...state, alwaysOnTop: value }),
      setContentProtection: async () => undefined,
      setSize: async () => undefined,
      moveTo: async () => undefined,
      onStateChange: () => () => undefined,
    },
    settings: {
      get: async () => settings,
      update: async (patch) => (settings = applySettingsPatch(settings, patch)),
      shortcutStatus: async () => ({
        toggleWindow: { accelerator: settings.shortcuts.toggleWindow, registered: true },
        toggleCapture: { accelerator: settings.shortcuts.toggleCapture, registered: true },
        askAi: { accelerator: settings.shortcuts.askAi, registered: true },
      }),
      onChange: () => () => undefined,
    },
    ai: {
      status: async () => ({
        provider: 'local',
        apiKeySet: false,
        reachable: true,
        endpoint: 'http://127.0.0.1:11434',
        version: '0.9.0',
        models: [{ name: 'qwen2.5:7b', sizeBytes: 4e9 }],
        activeModel: 'qwen2.5:7b',
        modelMissing: false,
      }),
      setApiKey: async () => {
        throw new Error('not used');
      },
      start: async (req) => {
        aiRequests.push(req);
        return `req-${aiRequests.length}`;
      },
      cancel: (id) => calls.push(`cancel:${id}`),
      onEvent: (l) => {
        ai.add(l);
        return () => ai.delete(l);
      },
    },
    stt: {
      status: async () => ({ engine: 'stopped', capture: 'idle', queue: 0 }),
      start: async () => ({ engine: 'starting', capture: 'recording', queue: 0 }),
      pause: async () => ({ engine: 'ready', capture: 'paused', queue: 0 }),
      resume: async () => ({ engine: 'ready', capture: 'recording', queue: 0 }),
      stop: async () => ({ engine: 'ready', capture: 'idle', queue: 0 }),
      pushAudio: () => undefined,
      test: async () => ({ engine: 'ready', capture: 'idle', queue: 0 }),
      onEvent: (l) => {
        stt.add(l);
        return () => stt.delete(l);
      },
    },
    history: {
      list: async () => [],
      get: async () => null,
      delete: async () => undefined,
      clear: async () => undefined,
    },
  };

  return {
    api,
    calls,
    aiRequests,
    emitAi: (e: AiEvent) => ai.forEach((l) => l(e)),
    emitStt: (e: SttEvent) => stt.forEach((l) => l(e)),
    emitShortcut: (a: ShortcutAction) => shortcuts.forEach((l) => l(a)),
    get settings() {
      return settings;
    },
  };
}

export type FakeApi = ReturnType<typeof createFakeApi>;
