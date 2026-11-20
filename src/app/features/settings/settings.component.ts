import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Diagnostics, ShortcutAction, ShortcutStatus, SttStatus } from '../../../../shared/ipc';
import type { AiProvider, PositionPreset, SettingsPatch } from '../../../../shared/settings';
import { AiService, cleanIpcError } from '../../core/ai.service';
import { listMicrophones } from '../../core/audio-capture';
import { ElectronBridgeService } from '../../core/electron-bridge.service';
import { RESUME_ACCEPT, extractResumeText } from '../../core/resume-import';
import { SettingsService } from '../../core/settings.service';
import { TranscriptService } from '../../core/transcript.service';
import { OllamaSetupComponent, formatSize } from '../../shared/ollama-setup.component';

const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  toggleWindow: 'Show / hide window',
  toggleCapture: 'Start / pause capture',
  askAi: 'Answer last question',
};

/** Convert a keydown into an Electron accelerator, e.g. "CommandOrControl+Shift+K". */
export function toAccelerator(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
  else {
    const named: Record<string, string> = {
      ' ': 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down',
      ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Escape',
    };
    key = named[e.key] ?? '';
  }
  if (!key) return null;
  // Global shortcuts without a modifier would swallow normal typing (F-keys are fine).
  if (parts.length === 0 && !/^F\d{1,2}$/.test(key)) return null;
  return [...parts, key].join('+');
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, OllamaSetupComponent],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  private readonly bridge = inject(ElectronBridgeService);
  private readonly settingsService = inject(SettingsService);
  readonly ai = inject(AiService);
  readonly transcript = inject(TranscriptService);

  readonly active = input(false);

  readonly s = this.settingsService.settings;
  readonly shortcutLabels = SHORTCUT_LABELS;
  readonly shortcutActions = Object.keys(SHORTCUT_LABELS) as ShortcutAction[];
  readonly presets: { id: PositionPreset; label: string }[] = [
    { id: 'top-left', label: 'Top left' },
    { id: 'top-right', label: 'Top right' },
    { id: 'center', label: 'Center' },
    { id: 'bottom-left', label: 'Bottom left' },
    { id: 'bottom-right', label: 'Bottom right' },
  ];
  readonly resumeAccept = RESUME_ACCEPT;
  readonly formatSize = formatSize;
  readonly formatAccelerator = (a: string) => a.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl');

  readonly mics = signal<{ deviceId: string; label: string }[]>([]);
  readonly shortcutStatus = signal<ShortcutStatus | null>(null);
  readonly recording = signal<ShortcutAction | null>(null);
  readonly sttTest = signal<SttStatus | null>(null);
  readonly sttTesting = signal(false);
  readonly diagnostics = signal<Diagnostics | null>(null);
  readonly resumeStatus = signal<string | null>(null);
  readonly sizeDraft = signal({ width: 420, height: 640 });
  readonly saved = signal(false);
  /** The API key being typed; cleared once saved, never read back from the main process. */
  apiKeyDraft = '';
  readonly apiKeyError = signal<string | null>(null);

  /** The configured model is not in Ollama's installed list (still offered in the dropdown). */
  readonly configuredModelMissing = computed(() => {
    if (this.ai.status()?.provider !== 'local') return false;
    const model = this.s().ollama.model;
    return !!model && !(this.ai.status()?.models ?? []).some((m) => m.name === model);
  });

  readonly remoteEndpoint = computed(() => {
    try {
      const host = new URL(this.s().ollama.endpoint).hostname;
      return !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
    } catch {
      return false;
    }
  });

  /** Guidance for local AI. Not for a remote endpoint: installing Ollama here would not help. */
  readonly showOllamaSetup = computed(() => this.s().ai.provider === 'local' && this.ai.needsSetup() && !this.remoteEndpoint());

  /** A problem to show in red. Not while the steps to set things up are on screen: those say the same, more kindly. */
  readonly statusError = computed(() => {
    const st = this.ai.status();
    if (!st?.error || this.showOllamaSetup() || (st.provider === 'groq' && !st.apiKeySet)) return null;
    return st.error;
  });

  constructor() {
    effect(() => {
      // untracked: refresh() writes signals right away, which an effect may not do (NG0600),
      // and only opening the tab should trigger it, not every settings change it reads.
      if (this.active()) untracked(() => void this.refresh());
    });
  }

  async refresh(): Promise<void> {
    const b = this.s().overlay.bounds;
    if (b) this.sizeDraft.set({ width: b.width, height: b.height });
    const [shortcuts] = await Promise.all([
      this.bridge.api.settings.shortcutStatus(),
      this.ai.refreshStatus(),
      this.loadMics(),
    ]);
    this.shortcutStatus.set(shortcuts);
  }

  async update(patch: SettingsPatch): Promise<void> {
    await this.settingsService.update(patch);
    this.saved.set(true);
    setTimeout(() => this.saved.set(false), 1200);
  }

  // ------------------------------------------------------------- AI

  async setEndpoint(value: string): Promise<void> {
    await this.update({ ollama: { endpoint: value } });
    await this.ai.refreshStatus();
  }

  async setModel(model: string): Promise<void> {
    await this.update({ ollama: { model } });
    await this.ai.refreshStatus();
  }

  async setProvider(provider: AiProvider): Promise<void> {
    this.apiKeyError.set(null);
    await this.update({ ai: { provider } });
    await this.ai.refreshStatus();
  }

  async setGroqModel(groqModel: string): Promise<void> {
    await this.update({ ai: { groqModel } });
    await this.ai.refreshStatus();
  }

  async saveApiKey(): Promise<void> {
    this.apiKeyError.set(null);
    try {
      await this.ai.setApiKey(this.apiKeyDraft.trim());
      this.apiKeyDraft = '';
    } catch (err) {
      this.apiKeyError.set(cleanIpcError(err));
    }
  }

  async removeApiKey(): Promise<void> {
    this.apiKeyError.set(null);
    await this.ai.setApiKey('');
  }

  // ----------------------------------------------------------- speech

  async testStt(): Promise<void> {
    this.sttTesting.set(true);
    try {
      this.sttTest.set(await this.bridge.api.stt.test());
    } finally {
      this.sttTesting.set(false);
    }
  }

  async loadMics(): Promise<void> {
    this.mics.set(await listMicrophones().catch(() => []));
  }

  async revokeConsent(): Promise<void> {
    if (this.transcript.capture() !== 'idle') await this.transcript.stop();
    await this.update({ privacy: { captureConsent: false } });
  }

  // ---------------------------------------------------------- overlay

  setOpacity(percent: number): void {
    void this.update({ overlay: { opacity: percent / 100 } });
  }

  async applySize(): Promise<void> {
    const { width, height } = this.sizeDraft();
    await this.bridge.api.window.setSize(Number(width), Number(height));
  }

  moveTo(preset: PositionPreset): void {
    void this.bridge.api.window.moveTo(preset);
  }

  // -------------------------------------------------------- shortcuts

  onShortcutKey(action: ShortcutAction, event: KeyboardEvent): void {
    if (this.recording() !== action) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      this.recording.set(null);
      return;
    }
    if (event.key === 'Backspace' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      void this.saveShortcut(action, '');
      return;
    }
    const accel = toAccelerator(event);
    if (accel) void this.saveShortcut(action, accel);
  }

  private async saveShortcut(action: ShortcutAction, accelerator: string): Promise<void> {
    this.recording.set(null);
    await this.update({ shortcuts: { [action]: accelerator } });
    this.shortcutStatus.set(await this.bridge.api.settings.shortcutStatus());
  }

  // ---------------------------------------------------------- privacy

  openDataFolder(): void {
    void this.bridge.api.openDataFolder();
  }

  async clearHistory(): Promise<void> {
    if (!confirm('Delete all saved sessions? This cannot be undone.')) return;
    await this.bridge.api.history.clear();
  }

  // ---------------------------------------------------------- profile

  async importResume(event: Event): Promise<void> {
    const inputEl = event.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    this.resumeStatus.set(`Reading ${file.name}…`);
    try {
      const text = await extractResumeText(file);
      await this.update({ profile: { resumeText: text } });
      this.resumeStatus.set(`Imported ${file.name} (${text.length.toLocaleString()} characters).`);
    } catch (err) {
      this.resumeStatus.set(`Could not import ${file.name}: ${cleanIpcError(err)}`);
    }
  }

  // ------------------------------------------------------ diagnostics

  async loadDiagnostics(): Promise<void> {
    this.diagnostics.set(await this.bridge.api.getDiagnostics());
  }

  async copyDiagnostics(): Promise<void> {
    const d = this.diagnostics() ?? (await this.bridge.api.getDiagnostics());
    this.diagnostics.set(d);
    // No transcripts, resume text or prompts: only versions, paths and statuses.
    await this.bridge.api.copyText(JSON.stringify(d, null, 2));
  }
}
