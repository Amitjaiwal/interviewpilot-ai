import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC, InterviewPilotApi } from '../shared/ipc';

/**
 * The preload runs in an isolated, sandboxed context. It exposes a small,
 * explicit API to Angular instead of handing over ipcRenderer itself.
 */

/** Subscribe to a main-process event channel; returns an unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: InterviewPilotApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  copyText: (text) => ipcRenderer.invoke(IPC.appCopy, text),
  openDataFolder: () => ipcRenderer.invoke(IPC.appOpenDataFolder),
  getDiagnostics: () => ipcRenderer.invoke(IPC.appDiagnostics),
  onShortcut: (listener) => subscribe(IPC.appShortcut, listener),

  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    hide: () => ipcRenderer.send(IPC.windowHide),
    close: () => ipcRenderer.send(IPC.windowClose),
    getState: () => ipcRenderer.invoke(IPC.windowGetState),
    setAlwaysOnTop: (value) => ipcRenderer.invoke(IPC.windowSetAlwaysOnTop, value),
    setContentProtection: (value) => ipcRenderer.invoke(IPC.windowSetContentProtection, value),
    setSize: (width, height) => ipcRenderer.invoke(IPC.windowSetSize, width, height),
    moveTo: (preset) => ipcRenderer.invoke(IPC.windowMoveTo, preset),
    onStateChange: (listener) => subscribe(IPC.windowStateChanged, listener),
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    shortcutStatus: () => ipcRenderer.invoke(IPC.shortcutStatus),
    onChange: (listener) => subscribe(IPC.settingsChanged, listener),
  },

  ai: {
    status: () => ipcRenderer.invoke(IPC.ollamaStatus),
    setApiKey: (key) => ipcRenderer.invoke(IPC.aiSetApiKey, key),
    start: (request) => ipcRenderer.invoke(IPC.aiStart, request),
    cancel: (requestId) => ipcRenderer.send(IPC.aiCancel, requestId),
    onEvent: (listener) => subscribe(IPC.aiEvent, listener),
  },

  stt: {
    status: () => ipcRenderer.invoke(IPC.sttStatus),
    start: (request) => ipcRenderer.invoke(IPC.sttStart, request),
    pause: () => ipcRenderer.invoke(IPC.sttPause),
    resume: () => ipcRenderer.invoke(IPC.sttResume),
    stop: () => ipcRenderer.invoke(IPC.sttStop),
    pushAudio: (source, pcm) => ipcRenderer.send(IPC.sttAudio, source, pcm),
    test: () => ipcRenderer.invoke(IPC.sttTest),
    onEvent: (listener) => subscribe(IPC.sttEvent, listener),
  },

  history: {
    list: (query) => ipcRenderer.invoke(IPC.historyList, query),
    get: (id) => ipcRenderer.invoke(IPC.historyGet, id),
    delete: (id) => ipcRenderer.invoke(IPC.historyDelete, id),
    clear: () => ipcRenderer.invoke(IPC.historyClear),
  },
};

contextBridge.exposeInMainWorld('interviewPilot', api);
