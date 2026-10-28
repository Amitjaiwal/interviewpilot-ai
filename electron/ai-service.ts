import { randomUUID } from 'node:crypto';
import type { AiEvent, AiRequest, AiStatus } from '../shared/ipc';
import type { Settings } from '../shared/settings';
import type { GroqClient } from './groq-client';
import type { HistoryStore } from './history-store';
import type { Logger } from './logger';
import { OllamaChatOptions, OllamaClient, OllamaError, OllamaMessage } from './ollama-client';
import { buildChat } from './prompts';

/** Coalesce tiny token deltas into fewer IPC messages. */
const CHUNK_FLUSH_MS = 40;

type Generate = (messages: OllamaMessage[], options: OllamaChatOptions, onDelta: (t: string) => void, signal: AbortSignal) => Promise<string>;

/**
 * Runs AI requests against the selected provider and streams the output to the
 * renderer as AiEvents. With Groq selected, a request that fails before any
 * text arrived (offline, rate limit, bad key) is answered by local Ollama instead.
 * Each request can be cancelled by id.
 */
export class AiService {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly client: OllamaClient,
    private readonly groq: GroqClient,
    private readonly groqKey: () => string,
    private readonly settings: () => Settings,
    private readonly history: HistoryStore,
    private readonly log: Logger,
    private readonly emit: (event: AiEvent) => void,
  ) {}

  async status(): Promise<AiStatus> {
    const s = this.settings();
    const apiKeySet = !!this.groqKey();
    if (s.ai.provider === 'groq') {
      return { ...(await this.groq.status(this.groqKey(), s.ai.groqModel)), provider: 'groq', apiKeySet };
    }
    return { ...(await this.client.status(s.ollama.endpoint, s.ollama.model)), provider: 'local', apiKeySet };
  }

  /** Start a request in the background and return its id immediately. */
  start(req: AiRequest): string {
    const requestId = randomUUID();
    const controller = new AbortController();
    this.running.set(requestId, controller);
    void this.run(requestId, req, controller.signal).finally(() => this.running.delete(requestId));
    return requestId;
  }

  /**
   * Prepare for the first answer of a session. Best effort. Local: load the
   * model into memory. Groq: open the HTTPS connection and learn the model list.
   */
  async warm(): Promise<void> {
    const s = this.settings();
    try {
      if (s.ai.provider === 'groq') {
        await this.groq.status(this.groqKey(), s.ai.groqModel);
        return;
      }
      const status = await this.client.status(s.ollama.endpoint, s.ollama.model);
      if (!status.activeModel) return;
      await this.client.warm(s.ollama.endpoint, status.activeModel);
      this.log.info('ai', `preloaded ${status.activeModel}`);
    } catch (err) {
      this.log.warn('ai', `preload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  cancel(requestId: string): void {
    this.running.get(requestId)?.abort();
  }

  cancelAll(): void {
    for (const c of this.running.values()) c.abort();
  }

  private async run(requestId: string, req: AiRequest, signal: AbortSignal): Promise<void> {
    const settings = this.settings();
    const started = Date.now();
    let pending = '';
    let streamed = false;
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (pending) this.emit({ requestId, type: 'chunk', text: pending });
      pending = '';
    };
    const onDelta = (delta: string) => {
      streamed = true;
      pending += delta;
      flushTimer ??= setTimeout(flush, CHUNK_FLUSH_MS);
    };

    try {
      const { messages, options } = buildChat(req, settings);
      let result: { text: string; model: string };
      if (settings.ai.provider === 'groq') {
        try {
          result = await this.generate(requestId, this.groqTarget(settings), messages, options, onDelta, signal);
        } catch (err) {
          // Mid-answer failures and cancellations are reported as they are.
          if (streamed || signal.aborted) throw err;
          const code = err instanceof OllamaError ? err.code : 'http';
          this.log.warn('ai', `groq failed (${code}), answering with local Ollama instead`);
          const local = await this.localTarget(settings, ' (Groq unavailable, local)').catch(() => {
            throw err;
          });
          result = await this.generate(requestId, local, messages, options, onDelta, signal);
        }
      } else {
        result = await this.generate(requestId, await this.localTarget(settings), messages, options, onDelta, signal);
      }
      flush();
      const durationMs = Date.now() - started;
      this.emit({ requestId, type: 'done', text: result.text, durationMs });
      this.log.info('ai', `${req.mode} completed with ${result.model} in ${durationMs} ms`);
      this.record(req, result.text, result.model);
    } catch (err) {
      flush();
      const e = err instanceof OllamaError ? err : new OllamaError('http', err instanceof Error ? err.message : String(err));
      if (e.code !== 'aborted') this.log.warn('ai', `${req.mode} failed: ${e.code}`);
      this.emit({ requestId, type: 'error', code: e.code, message: e.message });
    }
  }

  private async generate(
    requestId: string,
    target: { model: string; label: string; generate: Generate },
    messages: OllamaMessage[],
    options: OllamaChatOptions,
    onDelta: (t: string) => void,
    signal: AbortSignal,
  ): Promise<{ text: string; model: string }> {
    this.emit({ requestId, type: 'start', model: target.label });
    const text = await target.generate(messages, options, onDelta, signal);
    return { text, model: target.model };
  }

  private groqTarget(settings: Settings): { model: string; label: string; generate: Generate } {
    const model = this.groq.pickModel(settings.ai.groqModel);
    return {
      model: `groq:${model}`,
      label: `${model} (Groq)`,
      generate: (messages, options, onDelta, signal) => this.groq.chat(this.groqKey(), model, messages, options, onDelta, signal),
    };
  }

  private async localTarget(settings: Settings, suffix = ''): Promise<{ model: string; label: string; generate: Generate }> {
    const { endpoint } = settings.ollama;
    const status = await this.client.status(endpoint, settings.ollama.model);
    if (!status.reachable) throw new OllamaError('unreachable', status.error ?? 'Ollama is not reachable');
    if (status.modelMissing) throw new OllamaError('model-missing', status.error ?? 'Model not installed');
    const model = status.activeModel;
    if (!model) throw new OllamaError('no-model', 'No Ollama model installed. Run: ollama pull qwen3:8b');
    return {
      model,
      label: model + suffix,
      generate: (messages, options, onDelta, signal) => this.client.chat(endpoint, model, messages, options, onDelta, signal),
    };
  }

  private record(req: AiRequest, response: string, model: string): void {
    if (!req.sessionId || !req.kind || !this.settings().privacy.saveHistory) return;
    const prompt = req.mode === 'evaluate' ? `${req.question ?? ''}\n\nMy answer: ${req.input}` : req.input || req.question || '';
    this.history.appendExchange(req.sessionId, req.kind, { mode: req.mode, prompt, response, model, at: Date.now() });
  }
}
