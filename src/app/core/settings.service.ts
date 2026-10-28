import { Injectable, inject, signal } from '@angular/core';
import { DEFAULT_SETTINGS, Settings, SettingsPatch } from '../../../shared/settings';
import { ElectronBridgeService } from './electron-bridge.service';

/** Renderer-side view of the settings owned by the main process. */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly bridge = inject(ElectronBridgeService);
  readonly settings = signal<Settings>(DEFAULT_SETTINGS);
  readonly loaded = signal(false);

  constructor() {
    this.bridge.listen(this.bridge.api.settings.onChange, (s) => this.settings.set(s));
  }

  async load(): Promise<Settings> {
    const s = await this.bridge.api.settings.get();
    this.settings.set(s);
    this.loaded.set(true);
    return s;
  }

  /** Send a partial update; the main process validates it and returns the result. */
  async update(patch: SettingsPatch): Promise<Settings> {
    const s = await this.bridge.api.settings.update(patch);
    this.settings.set(s);
    return s;
  }
}
