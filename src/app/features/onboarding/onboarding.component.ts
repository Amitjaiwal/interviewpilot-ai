import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SttStatus } from '../../../../shared/ipc';
import type { AiProvider } from '../../../../shared/settings';
import { AiService, cleanIpcError } from '../../core/ai.service';
import { listMicrophones } from '../../core/audio-capture';
import { ElectronBridgeService } from '../../core/electron-bridge.service';
import { SettingsService } from '../../core/settings.service';
import { OllamaSetupComponent } from '../../shared/ollama-setup.component';

type Step = 'welcome' | 'provider' | 'connect' | 'speech' | 'done';

const STEPS: Step[] = ['welcome', 'provider', 'connect', 'speech', 'done'];

/**
 * First-run setup of a new installation: welcome, choose the AI provider, connect it, check
 * speech recognition, done. Every step can be skipped, because transcription works without AI.
 */
@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [FormsModule, OllamaSetupComponent],
  templateUrl: './onboarding.component.html',
  styleUrl: './onboarding.component.scss',
})
export class OnboardingComponent {
  private readonly bridge = inject(ElectronBridgeService);
  private readonly settings = inject(SettingsService);
  readonly ai = inject(AiService);

  /** The show/hide shortcut, as text. The window has no taskbar button, so people need to know it. */
  readonly toggleShortcut = input('');

  readonly steps = STEPS;
  readonly step = signal<Step>('welcome');
  readonly stepIndex = computed(() => STEPS.indexOf(this.step()));
  readonly provider = signal<AiProvider>(this.settings.settings().ai.provider);

  /** The key being typed; cleared once saved, never read back from the main process. */
  keyDraft = '';
  readonly keyError = signal<string | null>(null);

  readonly speech = signal<SttStatus | null>(null);
  readonly speechChecking = signal(false);
  readonly micFound = signal(true);
  readonly micBlocked = signal(false);

  /** The chosen provider has answered and has a model to use. */
  readonly aiReady = computed(() => {
    const s = this.ai.status();
    return !!s && s.provider === this.provider() && s.reachable && !!s.activeModel && !s.modelMissing;
  });
  /** Groq has a key that may simply be untestable for now, for example with no internet. */
  readonly keyUnverified = computed(() => {
    const s = this.ai.status();
    return this.provider() === 'groq' && !!s?.apiKeySet && !s.keyRejected && !this.aiReady();
  });
  /** Why the key could not be tested, without the technical cause that Settings still shows for troubleshooting. */
  readonly connectionProblem = computed(() => (this.ai.status()?.error ?? '').replace(/\s*\([^)]*\)$/, ''));
  readonly providerName = computed(() => (this.provider() === 'groq' ? 'Groq Cloud AI' : 'Ollama Local AI'));

  next(): void {
    this.step.set(STEPS[this.stepIndex() + 1]);
  }

  back(): void {
    this.step.set(STEPS[this.stepIndex() - 1]);
  }

  async confirmProvider(): Promise<void> {
    await this.settings.update({ ai: { provider: this.provider() } });
    this.step.set('connect');
    await this.ai.refreshStatus();
  }

  async saveKey(): Promise<void> {
    if (!this.keyDraft.trim() || this.ai.checking()) return;
    this.keyError.set(null);
    try {
      await this.ai.setApiKey(this.keyDraft.trim());
      this.keyDraft = '';
    } catch (err) {
      this.keyError.set(cleanIpcError(err));
    }
  }

  async replaceKey(): Promise<void> {
    this.keyError.set(null);
    await this.ai.setApiKey('');
  }

  continueToSpeech(): void {
    this.step.set('speech');
    void this.checkSpeech();
  }

  async checkSpeech(): Promise<void> {
    this.speechChecking.set(true);
    try {
      const [status, mics, access] = await Promise.all([
        this.bridge.api.stt.test(),
        listMicrophones().catch(() => []),
        this.bridge.api.stt.micAccess().catch(() => 'unknown'),
      ]);
      this.speech.set(status);
      this.micFound.set(mics.length > 0);
      this.micBlocked.set(access === 'denied' || access === 'restricted');
    } catch (err) {
      this.speech.set({ engine: 'error', capture: 'idle', queue: 0, error: cleanIpcError(err) });
    } finally {
      this.speechChecking.set(false);
    }
  }

  /** Finished or skipped: from here on the app opens normally, and Settings has everything from these steps. */
  async finish(): Promise<void> {
    await this.settings.update({ setup: { onboardingDone: true } });
  }
}
