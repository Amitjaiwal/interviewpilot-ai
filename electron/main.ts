import {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
  app,
  clipboard,
  desktopCapturer,
  ipcMain,
  session,
  shell,
} from 'electron';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppInfo, Diagnostics, IPC, ShortcutAction } from '../shared/ipc';
import { AiService } from './ai-service';
import { GroqClient } from './groq-client';
import { HistoryStore } from './history-store';
import { Logger } from './logger';
import { OllamaClient } from './ollama-client';
import { SecretStore } from './secret-store';
import { SettingsStore } from './settings-store';
import { ShortcutManager } from './shortcuts';
import { TranscriptionService } from './stt/transcription-service';
import { WhisperEngine } from './stt/whisper-engine';
import {
  ValidationError,
  validateAiRequest,
  validateApiKey,
  validateId,
  validatePcm,
  validatePreset,
  validateSource,
  validateSttStart,
} from './validation';
import { WindowManager } from './window-manager';

const DEV_SERVER_URL = process.env['ELECTRON_START_URL'];

// Optional data-folder override for tests or a portable setup. Must run before 'ready'.
const USER_DATA_OVERRIDE = process.env['INTERVIEWPILOT_USER_DATA'];
if (USER_DATA_OVERRIDE) app.setPath('userData', path.resolve(USER_DATA_OVERRIDE));

// Only one instance: a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.interviewpilot.app');
  void app.whenReady().then(bootstrap);
}

function bootstrap(): void {
  const userData = app.getPath('userData');
  const log = new Logger(path.join(userData, 'logs', 'main.log'));
  log.info(
    'runtime',
    `Electron=${process.versions.electron} OS=${process.platform} OSVersion=${os.release()}`,
  );
  const settings = new SettingsStore(path.join(userData, 'settings.json'));
  settings.load();
  log.info('settings', `overlay.contentProtection=${settings.get().overlay.contentProtection}`);
  const history = new HistoryStore(path.join(userData, 'history'));
  const removed = history.prune(settings.get().privacy.historyRetentionDays);
  if (removed) log.info('history', `pruned ${removed} old session(s)`);

  const windows = new WindowManager(DEV_SERVER_URL, log, (bounds) => settings.update({ overlay: { bounds } }));

  // whisper.cpp lookup order: user data, bundled resources (installer), project tools folder (dev).
  const whisperRoots = [path.join(userData, 'whisper')];
  if (app.isPackaged) whisperRoots.push(path.join(process.resourcesPath, 'whisper'));
  else whisperRoots.push(path.join(app.getAppPath(), 'tools', 'whisper'));
  const engine = new WhisperEngine(log, whisperRoots);

  const transcription = new TranscriptionService(
    engine,
    () => settings.get(),
    history,
    log,
    (event) => windows.send(IPC.sttEvent, event),
    path.join(userData, 'recordings'),
  );
  const secrets = new SecretStore(path.join(userData, 'secrets.json'));
  const ai = new AiService(
    new OllamaClient(),
    new GroqClient(),
    () => secrets.groqApiKey,
    () => settings.get(),
    history,
    log,
    (event) => windows.send(IPC.aiEvent, event),
  );

  const shortcuts = new ShortcutManager((action: ShortcutAction) => {
    if (action === 'toggleWindow') return windows.toggleVisibility();
    // Show the answer without taking keyboard focus from the app the user is in.
    if (action === 'askAi' && windows.window && !windows.window.isVisible()) windows.window.showInactive();
    windows.send(IPC.appShortcut, action);
  });

  /** Only our own window's top frame may call privileged IPC. */
  const isTrusted = (sender: WebContents, frame: WebFrameMain | null | undefined): boolean => {
    const win = windows.window;
    if (!win || sender !== win.webContents || !frame || frame !== sender.mainFrame) return false;
    return DEV_SERVER_URL ? frame.url.startsWith(DEV_SERVER_URL) : frame.url.startsWith('file://');
  };

  configurePermissions(isTrusted, transcription, settings, log);

  app.on('second-instance', () => {
    const win = windows.window;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  settings.onChange((next, prev) => {
    if (next.overlay.opacity !== prev.overlay.opacity) windows.setOpacity(next.overlay.opacity);
    if (next.overlay.alwaysOnTop !== prev.overlay.alwaysOnTop) windows.setAlwaysOnTop(next.overlay.alwaysOnTop);
    if (next.overlay.contentProtection !== prev.overlay.contentProtection) {
      windows.setContentProtection(next.overlay.contentProtection);
    }
    if (JSON.stringify(next.shortcuts) !== JSON.stringify(prev.shortcuts)) shortcuts.apply(next.shortcuts);
    const sttKeys = ['mode', 'serverPath', 'modelPath', 'externalUrl', 'threads'] as const;
    if (sttKeys.some((k) => next.stt[k] !== prev.stt[k]) && transcription.captureState === 'idle') engine.stop();
    // Bounds change on every drag; the renderer does not need those updates.
    const { bounds: _a, ...overlayNext } = next.overlay;
    const { bounds: _b, ...overlayPrev } = prev.overlay;
    if (JSON.stringify({ ...next, overlay: overlayNext }) !== JSON.stringify({ ...prev, overlay: overlayPrev })) {
      windows.send(IPC.settingsChanged, next);
    }
  });

  registerIpc({ windows, settings, secrets, history, transcription, ai, shortcuts, log, isTrusted, userData });
  windows.create(settings.get().overlay);
  shortcuts.apply(settings.get().shortcuts);
  log.info('app', `started v${app.getVersion()}`);

  app.on('will-quit', () => {
    shortcuts.dispose();
    ai.cancelAll();
    void transcription.stop();
    engine.stop();
    history.flush();
  });
  app.on('window-all-closed', () => app.quit());
}

function configurePermissions(
  isTrusted: (sender: WebContents, frame: WebFrameMain | null | undefined) => boolean,
  transcription: TranscriptionService,
  settings: SettingsStore,
  log: Logger,
): void {
  const ses = session.defaultSession;

  // Microphone: granted only for audio-only requests from our window, after
  // the user accepted the capture notice and pressed Start. Everything else
  // (camera, notifications, geolocation...) stays denied.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    let granted = false;
    if (permission === 'media' && isTrusted(wc, wc.mainFrame) && settings.get().privacy.captureConsent) {
      const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
      const micRequest = types.length > 0 && types.every((t) => t === 'audio');
      // getDisplayMedia() arrives with no media types; the display-media handler below
      // then decides what is actually shared (loopback audio only).
      const displayRequest = types.length === 0;
      granted =
        (micRequest && transcription.isCapturing('mic')) || (displayRequest && transcription.isCapturing('system'));
    }
    if (!granted) log.info('permissions', `denied ${permission}`);
    callback(granted);
  });
  // Lets the renderer list microphone names once the user has consented.
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
    return (
      permission === 'media' &&
      details.mediaType === 'audio' &&
      !!wc &&
      isTrusted(wc, wc.mainFrame) &&
      settings.get().privacy.captureConsent
    );
  });

  // System audio: getDisplayMedia() in the renderer lands here. We answer with
  // the primary screen plus Windows loopback audio; the renderer discards the
  // video track immediately. Only allowed while a system-audio capture is active.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request.frame;
    const wc = frame ? BrowserWindow.getAllWindows().find((w) => w.webContents.mainFrame === frame)?.webContents : undefined;
    const reason = !wc || !isTrusted(wc, frame)
      ? 'untrusted frame'
      : !settings.get().privacy.captureConsent
        ? 'no consent'
        : !transcription.isCapturing('system')
          ? 'system capture not active'
          : '';
    if (reason) {
      log.info('permissions', `denied display media (${reason})`);
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => (sources[0] ? callback({ video: sources[0], audio: 'loopback' }) : callback({})))
      .catch(() => callback({}));
  });
}

interface Deps {
  windows: WindowManager;
  settings: SettingsStore;
  secrets: SecretStore;
  history: HistoryStore;
  transcription: TranscriptionService;
  ai: AiService;
  shortcuts: ShortcutManager;
  log: Logger;
  isTrusted: (sender: WebContents, frame: WebFrameMain | null | undefined) => boolean;
  userData: string;
}

function registerIpc(d: Deps): void {
  const { windows, settings, history, transcription, ai, shortcuts, log } = d;

  /** Register an invoke handler that rejects untrusted senders and reports validation errors cleanly. */
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!d.isTrusted(event.sender, event.senderFrame)) throw new Error('Untrusted sender');
      try {
        return await fn(...args);
      } catch (err) {
        if (!(err instanceof ValidationError)) log.error('ipc', `${channel} failed`, err);
        throw err;
      }
    });
  const on = (channel: string, fn: (...args: unknown[]) => void) =>
    ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      if (d.isTrusted(event.sender, event.senderFrame)) fn(...args);
    });

  const appInfo = (): AppInfo => ({
    name: 'InterviewPilot AI',
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    toggleShortcut: settings.get().shortcuts.toggleWindow,
  });

  handle(IPC.appInfo, appInfo);
  handle(IPC.appCopy, (text) => {
    if (typeof text === 'string') clipboard.writeText(text.slice(0, 200_000));
  });
  handle(IPC.appOpenDataFolder, async () => {
    await shell.openPath(d.userData);
  });
  handle(IPC.appDiagnostics, async (): Promise<Diagnostics> => ({
    app: appInfo(),
    userDataPath: d.userData,
    settingsPath: settings.path,
    historyPath: history.path,
    logPath: log.path,
    ollama: await ai.status(),
    stt: transcription.status(),
    shortcuts: shortcuts.status,
  }));

  on(IPC.windowMinimize, () => windows.window?.minimize());
  on(IPC.windowHide, () => windows.window?.hide());
  on(IPC.windowClose, () => windows.window?.close());
  handle(IPC.windowGetState, () => windows.state());
  handle(IPC.windowSetAlwaysOnTop, (value) => {
    settings.update({ overlay: { alwaysOnTop: value === true } });
    return windows.setAlwaysOnTop(value === true);
  });
  handle(IPC.windowSetContentProtection, (value) => {
    settings.update({ overlay: { contentProtection: value === true } });
    windows.setContentProtection(value === true);
  });
  handle(IPC.windowSetSize, (w, h) => {
    if (typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h)) windows.setSize(w, h);
  });
  handle(IPC.windowMoveTo, (preset) => {
    const p = validatePreset(preset);
    if (p) windows.moveTo(p);
  });

  handle(IPC.settingsGet, () => settings.get());
  handle(IPC.settingsUpdate, (patch) => settings.update(patch));
  handle(IPC.shortcutStatus, () => shortcuts.status);

  handle(IPC.ollamaStatus, () => ai.status());
  handle(IPC.aiSetApiKey, (key) => {
    d.secrets.setGroqApiKey(validateApiKey(key));
    log.info('ai', d.secrets.groqApiKey ? 'groq api key saved' : 'groq api key removed');
    return ai.status();
  });
  handle(IPC.aiStart, (req) => ai.start(validateAiRequest(req)));
  on(IPC.aiCancel, (id) => {
    if (typeof id === 'string') ai.cancel(id);
  });

  handle(IPC.sttStatus, () => transcription.status());
  handle(IPC.sttStart, (req) => {
    if (!settings.get().privacy.captureConsent) throw new ValidationError('Accept the capture notice first');
    const status = transcription.start(validateSttStart(req));
    // Questions will follow soon: load the AI model in the background meanwhile.
    void ai.warm();
    return status;
  });
  handle(IPC.sttPause, () => transcription.pause());
  handle(IPC.sttResume, () => transcription.resume());
  handle(IPC.sttStop, () => transcription.stop());
  handle(IPC.sttTest, () => transcription.test());
  on(IPC.sttAudio, (source, pcm) => {
    const s = validateSource(source);
    const samples = validatePcm(pcm);
    if (s && samples) transcription.pushAudio(s, samples);
  });

  handle(IPC.historyList, (query) => history.list(typeof query === 'string' ? query.slice(0, 200) : ''));
  handle(IPC.historyGet, (id) => {
    const valid = validateId(id);
    return valid ? history.get(valid) : null;
  });
  handle(IPC.historyDelete, (id) => {
    const valid = validateId(id);
    if (valid) history.delete(valid);
  });
  handle(IPC.historyClear, () => history.clear());
}
