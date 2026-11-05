import { Component, HostListener, NgZone, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import type { AppInfo, ShortcutAction, WindowState } from '../../shared/ipc';
import { AiService } from './core/ai.service';
import { ElectronBridgeService } from './core/electron-bridge.service';
import { SettingsService } from './core/settings.service';
import { TranscriptService } from './core/transcript.service';
import { ChatComponent } from './features/chat/chat.component';
import { HistoryComponent } from './features/history/history.component';
import { LiveComponent } from './features/live/live.component';
import { OnboardingComponent } from './features/onboarding/onboarding.component';
import { PracticeComponent } from './features/practice/practice.component';
import { SettingsComponent } from './features/settings/settings.component';

export type Tab = 'live' | 'chat' | 'practice' | 'history' | 'settings';

const OLLAMA_POLL_MS = 30_000;

/** Electron's "CommandOrControl" reads as plain "Ctrl" on Windows. */
export function formatAccelerator(accelerator: string): string {
  return accelerator.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl');
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [LiveComponent, ChatComponent, PracticeComponent, HistoryComponent, SettingsComponent, OnboardingComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly bridge = inject(ElectronBridgeService);
  private readonly settings = inject(SettingsService);
  private readonly zone = inject(NgZone);
  readonly ai = inject(AiService);
  readonly transcript = inject(TranscriptService);
  private readonly subscriptions: (() => void)[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly isElectron = this.bridge.isElectron;
  readonly info = signal<AppInfo | null>(null);
  readonly windowState = signal<WindowState>({ alwaysOnTop: false, focused: true });
  readonly tab = signal<Tab>('live');
  readonly tabs: { id: Tab; label: string }[] = [
    { id: 'live', label: 'Live' },
    { id: 'chat', label: 'Chat' },
    { id: 'practice', label: 'Practice' },
    { id: 'history', label: 'History' },
    { id: 'settings', label: 'Settings' },
  ];

  /** Nothing below the title bar is shown until settings arrive, so a new user never sees the main view flash by. */
  readonly settingsLoaded = this.settings.loaded;
  readonly onboarding = computed(() => !this.settings.settings().setup.onboardingDone);
  readonly capturing = computed(() => this.transcript.capture() !== 'idle');
  readonly micOn = computed(() => this.capturing() && this.transcript.activeSources().includes('mic'));
  readonly systemOn = computed(() => this.capturing() && this.transcript.activeSources().includes('system'));
  readonly toggleShortcut = computed(() =>
    formatAccelerator(this.settings.settings().shortcuts.toggleWindow || this.info()?.toggleShortcut || ''),
  );
  readonly ollamaLabel = computed(() => {
    const s = this.ai.status();
    if (!s) return 'AI: checking';
    if (s.provider === 'groq' && !s.apiKeySet) return 'AI: no key';
    if (s.keyRejected) return 'AI: bad key';
    if (!s.reachable) return 'AI: offline';
    if (s.modelMissing || !s.activeModel) return 'AI: no model';
    return s.provider === 'groq' ? 'AI: Groq' : `AI: ${s.activeModel}`;
  });
  readonly ollamaOk = computed(() => {
    const s = this.ai.status();
    return !!s?.reachable && !s.modelMissing && !!s.activeModel;
  });
  readonly sttLabel = computed(() => {
    const st = this.transcript.status();
    switch (st.engine) {
      case 'ready':
        return 'Speech: ready';
      case 'starting':
        return 'Speech: loading';
      case 'error':
        return 'Speech: error';
      default:
        return 'Speech: idle';
    }
  });

  private readonly live = viewChild(LiveComponent);

  async ngOnInit(): Promise<void> {
    this.subscriptions.push(
      this.bridge.listen(this.bridge.api.window.onStateChange, (state) => this.windowState.set(state)),
      this.bridge.listen(this.bridge.api.onShortcut, (action) => void this.onShortcut(action)),
    );
    const [info, state] = await Promise.all([
      this.bridge.api.getAppInfo(),
      this.bridge.api.window.getState(),
      this.settings.load(),
    ]);
    this.info.set(info);
    this.windowState.set(state);

    void this.ai.refreshStatus();
    // A repeating timer inside the zone would keep Angular permanently "unstable".
    this.zone.runOutsideAngular(() => {
      this.pollTimer = setInterval(() => this.zone.run(() => void this.ai.refreshStatus()), OLLAMA_POLL_MS);
    });
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async togglePin(): Promise<void> {
    const next = await this.bridge.api.window.setAlwaysOnTop(!this.windowState().alwaysOnTop);
    this.windowState.set(next);
  }

  minimize(): void {
    this.bridge.api.window.minimize();
  }

  hide(): void {
    this.bridge.api.window.hide();
  }

  close(): void {
    this.bridge.api.window.close();
  }

  /** Ctrl+1..5 switches tabs. */
  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (!event.ctrlKey || event.shiftKey || event.altKey) return;
    const index = Number(event.key) - 1;
    if (index >= 0 && index < this.tabs.length) {
      event.preventDefault();
      this.tab.set(this.tabs[index].id);
    }
  }

  private async onShortcut(action: ShortcutAction): Promise<void> {
    if (action === 'toggleCapture') {
      if (!this.settings.settings().privacy.captureConsent) {
        // Consent must be given in the UI; show it instead of starting silently.
        this.tab.set('live');
        await this.live()?.start();
        return;
      }
      await this.transcript.toggle();
    } else if (action === 'askAi') {
      this.tab.set('live');
      this.live()?.askFromShortcut();
    }
  }
}
