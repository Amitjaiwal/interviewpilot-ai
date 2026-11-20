import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SETTINGS, NEW_INSTALL_SETTINGS, Settings, applySettingsPatch, sanitizeSettings } from '../shared/settings';

type Listener = (next: Settings, previous: Settings) => void;

/**
 * Persists settings as JSON in the user-data folder. Reads are sanitised, so a
 * hand-edited or corrupt file falls back to defaults field by field.
 */
export class SettingsStore {
  private current: Settings = DEFAULT_SETTINGS;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly file: string) {}

  get path(): string {
    return this.file;
  }

  load(): Settings {
    try {
      this.current = sanitizeSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      this.current = DEFAULT_SETTINGS;
    }
    return this.current;
  }

  /** First launch of a new installation. Saved at once, so the next launch sees an existing user. */
  startNewInstall(): Settings {
    this.current = NEW_INSTALL_SETTINGS;
    this.save();
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  update(patch: unknown): Settings {
    const previous = this.current;
    const next = applySettingsPatch(previous, patch);
    if (JSON.stringify(next) === JSON.stringify(previous)) return previous;
    this.current = next;
    this.save();
    for (const listener of this.listeners) listener(next, previous);
    return next;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Write to a temp file and rename, so a crash mid-write cannot corrupt settings. */
  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.current, null, 2));
    renameSync(tmp, this.file);
  }
}
