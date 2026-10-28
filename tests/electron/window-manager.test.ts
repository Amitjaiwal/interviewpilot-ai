import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../electron/logger';
import { WindowManager } from '../../electron/window-manager';
import { DEFAULT_SETTINGS, Settings } from '../../shared/settings';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  /** Models Electron 33 on Windows: showing a hidden window resets its display affinity before 'show' fires. */
  class BrowserWindow extends EventEmitter {
    visible = false;
    excludedFromCapture = false;
    skippedFromTaskbar = false;
    readonly webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: () => undefined,
      send: () => undefined,
    });
    setAlwaysOnTop(): void {}
    setSkipTaskbar(value: boolean): void {
      this.skippedFromTaskbar = value;
    }
    setOpacity(): void {}
    setContentProtection(value: boolean): void {
      this.excludedFromCapture = value;
    }
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
    isVisible(): boolean {
      return this.visible;
    }
    isFocused(): boolean {
      return false;
    }
    isDestroyed(): boolean {
      return false;
    }
    focus(): void {}
    show(): void {
      this.reveal();
    }
    showInactive(): void {
      this.reveal();
    }
    hide(): void {
      if (!this.visible) return;
      this.visible = false;
      this.emit('hide');
    }
    private reveal(): void {
      if (this.visible) return;
      this.visible = true;
      this.excludedFromCapture = false;
      this.emit('show');
    }
  }
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  return {
    BrowserWindow,
    screen: {
      getAllDisplays: () => [{ workArea }],
      getPrimaryDisplay: () => ({ workArea }),
      getDisplayMatching: () => ({ workArea }),
    },
    shell: { openExternal: () => Promise.resolve() },
  };
});

interface FakeWindow {
  excludedFromCapture: boolean;
  skippedFromTaskbar: boolean;
  emit(event: string): boolean;
  hide(): void;
  showInactive(): void;
}

const log = { info: () => undefined, warn: () => undefined } as unknown as Logger;

/** Create the window from saved settings and let it appear, as at app startup. */
function start(contentProtection: boolean): { windows: WindowManager; win: FakeWindow } {
  const windows = new WindowManager(undefined, log);
  const overlay: Settings['overlay'] = { ...DEFAULT_SETTINGS.overlay, contentProtection };
  windows.create(overlay);
  const win = windows.window as unknown as FakeWindow;
  win.emit('ready-to-show');
  return { windows, win };
}

describe('WindowManager content protection', () => {
  it('applies the saved preference once the window first appears', () => {
    expect(start(true).win.excludedFromCapture).toBe(true);
  });

  describe('WindowManager taskbar behavior', () => {
    it('keeps the window excluded from the taskbar when shown', () => {
      const { windows, win } = start(false);
      expect(win.skippedFromTaskbar).toBe(true);

      win.hide();
      windows.toggleVisibility();

      expect(win.skippedFromTaskbar).toBe(true);
    });
  });

  it('leaves capture allowed when the saved preference is off', () => {
    expect(start(false).win.excludedFromCapture).toBe(false);
  });

  it('keeps protection after the window is hidden and shown again', () => {
    const { windows, win } = start(true);
    win.hide();
    windows.toggleVisibility();
    expect(win.excludedFromCapture).toBe(true);
    // The Ask AI shortcut reveals the window without focusing it.
    win.hide();
    win.showInactive();
    expect(win.excludedFromCapture).toBe(true);
  });

  it('applies a settings change to the visible window immediately', () => {
    const { windows, win } = start(true);
    windows.setContentProtection(false);
    expect(win.excludedFromCapture).toBe(false);
    windows.setContentProtection(true);
    expect(win.excludedFromCapture).toBe(true);
  });

  it('keeps a change made while hidden when the window is shown', () => {
    const { windows, win } = start(false);
    win.hide();
    windows.setContentProtection(true);
    windows.toggleVisibility();
    expect(win.excludedFromCapture).toBe(true);
    win.hide();
    windows.setContentProtection(false);
    windows.toggleVisibility();
    expect(win.excludedFromCapture).toBe(false);
  });
});
