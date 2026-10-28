import { globalShortcut } from 'electron';
import type { ShortcutAction, ShortcutStatus } from '../shared/ipc';
import type { Settings } from '../shared/settings';

const ACTIONS: ShortcutAction[] = ['toggleWindow', 'toggleCapture', 'askAi'];

/** Registers the user's global shortcuts and reports which ones the OS accepted. */
export class ShortcutManager {
  private current: ShortcutStatus = Object.fromEntries(
    ACTIONS.map((a) => [a, { accelerator: '', registered: false }]),
  ) as ShortcutStatus;

  constructor(private readonly handler: (action: ShortcutAction) => void) {}

  get status(): ShortcutStatus {
    return this.current;
  }

  apply(shortcuts: Settings['shortcuts']): ShortcutStatus {
    globalShortcut.unregisterAll();
    const seen = new Set<string>();
    const next = {} as ShortcutStatus;
    for (const action of ACTIONS) {
      const accelerator = shortcuts[action];
      if (!accelerator) {
        next[action] = { accelerator, registered: false };
        continue;
      }
      if (seen.has(accelerator.toLowerCase())) {
        next[action] = { accelerator, registered: false, error: 'Already used by another action' };
        continue;
      }
      seen.add(accelerator.toLowerCase());
      try {
        const ok = globalShortcut.register(accelerator, () => this.handler(action));
        next[action] = ok
          ? { accelerator, registered: true }
          : { accelerator, registered: false, error: 'In use by another application' };
      } catch {
        next[action] = { accelerator, registered: false, error: 'Not a valid shortcut' };
      }
    }
    this.current = next;
    return next;
  }

  dispose(): void {
    globalShortcut.unregisterAll();
  }
}
