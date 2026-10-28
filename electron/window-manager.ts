import { BrowserWindow, screen, shell } from 'electron';
import * as path from 'node:path';
import { IPC, WindowState } from '../shared/ipc';
import type { Bounds, PositionPreset, Settings } from '../shared/settings';
import type { Logger } from './logger';
import { MIN_SIZE, initialBounds, presetBounds, restoreBounds } from './window-bounds';

/**
 * Owns the single overlay window: creation, hardening, show/hide, opacity and
 * bounds. The window is frameless (we draw our own title bar in Angular) and
 * always-on-top by default so it can sit beside a practice session.
 */
export class WindowManager {
  private win: BrowserWindow | null = null;
  private boundsTimer: NodeJS.Timeout | null = null;
  /** Wanted content-protection state; re-applied every time the window is shown. */
  private contentProtection = false;

  constructor(
    private readonly devServerUrl: string | undefined,
    private readonly log: Logger,
    private readonly onBoundsChanged: (bounds: Bounds) => void = () => undefined,
  ) {}

  get window(): BrowserWindow | null {
    return this.win;
  }

  create(overlay: Settings['overlay']): BrowserWindow {
    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    const bounds = restoreBounds(overlay.bounds, workAreas) ?? initialBounds(screen.getPrimaryDisplay().workArea);

    const win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      frame: false,
      alwaysOnTop: overlay.alwaysOnTop,
      show: false,
      backgroundColor: '#0f1115',
      title: 'InterviewPilot AI',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        // Keep capture and streaming running while the window is hidden.
        backgroundThrottling: false,
      },
    });
    if (overlay.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
    win.setOpacity(overlay.opacity);
    this.contentProtection = overlay.contentProtection;
    this.applyContentProtection(win, this.contentProtection, 'create');

    this.harden(win);

    win.once('ready-to-show', () => {
      this.log.info('window', 'ready-to-show');
      win.show();
    });
    const emit = () => this.emitState();
    win.on('focus', emit);
    win.on('blur', emit);
    win.on('always-on-top-changed', emit);
    win.on('show', () => {
      this.log.info('window', 'shown');
      // On Windows, showing a hidden window (the first show included) resets its
      // display affinity, so protection applied while hidden would be lost.
      this.applyContentProtection(win, this.contentProtection, 'show');
    });
    win.on('hide', () => this.log.info('window', 'hidden'));
    win.on('moved', () => this.scheduleBoundsSave());
    win.on('resized', () => this.scheduleBoundsSave());
    win.on('closed', () => {
      this.log.info('window', 'closed');
      this.win = null;
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      this.log.warn('window', `renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
    });

    if (this.devServerUrl) {
      void win.loadURL(this.devServerUrl);
    } else {
      void win.loadFile(path.join(__dirname, '..', 'dist', 'interviewpilot', 'browser', 'index.html'));
    }

    this.win = win;
    return win;
  }

  state(): WindowState {
    return {
      alwaysOnTop: this.win?.isAlwaysOnTop() ?? false,
      focused: this.win?.isFocused() ?? false,
    };
  }

  setAlwaysOnTop(value: boolean): WindowState {
    // 'floating' keeps the window above normal windows without covering
    // system UI such as the taskbar or UAC prompts.
    this.win?.setAlwaysOnTop(value, 'floating');
    return this.state();
  }

  setContentProtection(value: boolean): void {
    this.contentProtection = value;
    if (this.win) this.applyContentProtection(this.win, value, 'settings-update');
  }

  setOpacity(value: number): void {
    this.win?.setOpacity(value);
  }

  setSize(width: number, height: number): void {
    if (!this.win) return;
    const workArea = screen.getDisplayMatching(this.win.getBounds()).workArea;
    const w = Math.round(Math.min(Math.max(width, MIN_SIZE.width), workArea.width));
    const h = Math.round(Math.min(Math.max(height, MIN_SIZE.height), workArea.height));
    this.win.setSize(w, h);
    this.scheduleBoundsSave();
  }

  moveTo(preset: PositionPreset): void {
    if (!this.win) return;
    const current = this.win.getBounds();
    const workArea = screen.getDisplayMatching(current).workArea;
    this.win.setBounds(presetBounds(preset, workArea, current));
    this.scheduleBoundsSave();
  }

  toggleVisibility(): void {
    if (!this.win) return;
    if (this.win.isVisible() && this.win.isFocused()) {
      this.win.hide();
    } else {
      this.win.show();
      this.win.focus();
    }
  }

  send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  /** Persist bounds shortly after the user stops dragging or resizing. */
  private scheduleBoundsSave(): void {
    if (this.boundsTimer) clearTimeout(this.boundsTimer);
    this.boundsTimer = setTimeout(() => {
      if (this.win && !this.win.isDestroyed() && !this.win.isMinimized()) this.onBoundsChanged(this.win.getBounds());
    }, 500);
  }

  private emitState(): void {
    this.send(IPC.windowStateChanged, this.state());
  }

  private applyContentProtection(win: BrowserWindow, value: boolean, source: string): void {
    this.log.info('window', `contentProtection before apply (${source}): requested=${value}`);
    win.setContentProtection(value);
    this.log.info(
      'window',
      `contentProtection after apply (${source}): setter completed; BrowserWindow has no isContentProtected() readback API`,
    );
  }

  /** Block navigation and popups; route external links to the default browser. */
  private harden(win: BrowserWindow): void {
    const isAppUrl = (url: string) =>
      this.devServerUrl ? url.startsWith(this.devServerUrl) : url.startsWith('file://');

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
  }
}
