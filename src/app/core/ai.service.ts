import { Injectable, computed, inject, signal } from '@angular/core';
import type { AiErrorCode, AiEvent, AiRequest, AiStatus, ModelPullProgress } from '../../../shared/ipc';
import { ElectronBridgeService } from './electron-bridge.service';

export type StreamState = 'pending' | 'streaming' | 'done' | 'error' | 'cancelled';

/** One streamed AI response. Views bind to its signals. */
export class AiStream {
  readonly text = signal('');
  readonly state = signal<StreamState>('pending');
  readonly error = signal<string | null>(null);
  readonly errorCode = signal<AiErrorCode | null>(null);
  readonly model = signal('');
  readonly durationMs = signal(0);
  requestId?: string;

  constructor(
    readonly request: AiRequest,
    private readonly cancelFn: (id: string) => void,
  ) {}

  get active(): boolean {
    const s = this.state();
    return s === 'pending' || s === 'streaming';
  }

  cancel(): void {
    if (!this.active) return;
    if (this.requestId) this.cancelFn(this.requestId);
    this.state.set('cancelled');
  }

  apply(event: AiEvent): void {
    if (this.state() === 'cancelled') return;
    switch (event.type) {
      case 'start':
        this.model.set(event.model);
        this.state.set('streaming');
        break;
      case 'chunk':
        this.text.update((t) => t + event.text);
        this.state.set('streaming');
        break;
      case 'done':
        this.text.set(event.text);
        this.durationMs.set(event.durationMs);
        this.state.set('done');
        break;
      case 'error':
        if (event.code === 'aborted') {
          this.state.set('cancelled');
        } else {
          this.error.set(event.message);
          this.errorCode.set(event.code);
          this.state.set('error');
        }
        break;
    }
  }
}

/** Starts AI requests in the main process and routes streamed events to their AiStream. */
@Injectable({ providedIn: 'root' })
export class AiService {
  private readonly bridge = inject(ElectronBridgeService);
  private readonly streams = new Map<string, AiStream>();
  /** Events that arrive before start() resolves with the request id. */
  private readonly early = new Map<string, AiEvent[]>();

  readonly status = signal<AiStatus | null>(null);
  readonly checking = signal(false);
  /** Set while the recommended model is downloading. */
  readonly pull = signal<ModelPullProgress | null>(null);
  readonly pullError = signal<string | null>(null);
  /**
   * The chosen AI cannot answer until the user does something. Groq: no key, or a rejected one.
   * Ollama: not running, or no models. Groq merely being unreachable is not a setup problem.
   */
  readonly needsSetup = computed(() => {
    const s = this.status();
    if (!s) return false;
    return s.provider === 'groq' ? !s.apiKeySet || !!s.keyRejected : !s.reachable || s.models.length === 0;
  });

  constructor() {
    this.bridge.listen(this.bridge.api.ai.onEvent, (event) => this.dispatch(event));
    this.bridge.listen(this.bridge.api.ai.onPullProgress, (progress) => {
      if (this.pull()) this.pull.set(progress);
    });
  }

  run(request: AiRequest): AiStream {
    const stream = new AiStream(request, (id) => this.bridge.api.ai.cancel(id));
    this.bridge.api.ai.start(request).then(
      (id) => {
        stream.requestId = id;
        if (stream.state() === 'cancelled') {
          this.bridge.api.ai.cancel(id);
          this.early.delete(id);
          return;
        }
        this.streams.set(id, stream);
        for (const e of this.early.get(id) ?? []) this.dispatch(e);
        this.early.delete(id);
      },
      (err: unknown) => {
        stream.error.set(cleanIpcError(err));
        stream.errorCode.set('invalid');
        stream.state.set('error');
      },
    );
    return stream;
  }

  async refreshStatus(): Promise<AiStatus> {
    this.checking.set(true);
    try {
      const s = await this.bridge.api.ai.status();
      this.status.set(s);
      return s;
    } finally {
      this.checking.set(false);
    }
  }

  /** Save (or with '' remove) the Groq API key; the main process encrypts it. */
  async setApiKey(key: string): Promise<AiStatus> {
    this.checking.set(true);
    try {
      const s = await this.bridge.api.ai.setApiKey(key);
      this.status.set(s);
      return s;
    } finally {
      this.checking.set(false);
    }
  }

  async pullRecommendedModel(): Promise<void> {
    this.pullError.set(null);
    this.pull.set({ status: 'starting' });
    try {
      this.status.set(await this.bridge.api.ai.pullRecommendedModel());
    } catch (err) {
      this.pullError.set(cleanIpcError(err));
    } finally {
      this.pull.set(null);
    }
  }

  cancelPull(): void {
    this.bridge.api.ai.cancelPull();
  }

  private dispatch(event: AiEvent): void {
    const stream = this.streams.get(event.requestId);
    if (!stream) {
      const list = this.early.get(event.requestId) ?? [];
      list.push(event);
      this.early.set(event.requestId, list);
      return;
    }
    stream.apply(event);
    if (event.type === 'done' || event.type === 'error') this.streams.delete(event.requestId);
  }
}

/** Electron prefixes errors thrown in handlers with "Error invoking remote method ...". */
export function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
