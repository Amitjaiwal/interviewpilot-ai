import type { AiErrorCode, OllamaModel, OllamaStatus } from '../shared/ipc';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatOptions {
  temperature?: number;
  num_predict?: number;
  num_ctx?: number;
}

export class OllamaError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_TIMEOUT_MS = 3000;
/** Give a cold model this long to produce its first token before failing. */
const FIRST_TOKEN_TIMEOUT_MS = 120_000;
/**
 * Ollama unloads an idle model after 5 minutes by default, and reloading a 7B
 * model costs ~4 s before the first token. Keep it resident through an interview.
 */
const KEEP_ALIVE = '30m';

/**
 * Talks to a local Ollama server over its HTTP API. Runs in the main process
 * only; the renderer never sees the endpoint or makes network calls itself.
 */
export class OllamaClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async status(endpoint: string, configuredModel: string): Promise<OllamaStatus> {
    const base: OllamaStatus = { reachable: false, endpoint, models: [], modelMissing: false };
    try {
      const [version, tags] = await Promise.all([
        this.getJson<{ version?: string }>(`${endpoint}/api/version`),
        this.getJson<{ models?: { name: string; size?: number; details?: { parameter_size?: string } }[] }>(
          `${endpoint}/api/tags`,
        ),
      ]);
      const models: OllamaModel[] = (tags.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size ?? 0,
        parameterSize: m.details?.parameter_size,
      }));
      const resolved = resolveModel(configuredModel, models);
      return {
        ...base,
        reachable: true,
        version: version.version,
        models,
        activeModel: resolved.model,
        modelMissing: resolved.missing,
        error: resolved.missing
          ? `Model "${configuredModel}" is not installed. Run: ollama pull ${configuredModel}`
          : models.length === 0
            ? 'No models installed. Run: ollama pull qwen2.5:7b'
            : undefined,
      };
    } catch (err) {
      return { ...base, error: describeConnectionError(endpoint, err) };
    }
  }

  /**
   * Streams a chat completion. `onChunk` receives each text delta; the promise
   * resolves with the full text once Ollama reports `done`.
   */
  async chat(
    endpoint: string,
    model: string,
    messages: OllamaMessage[],
    options: OllamaChatOptions,
    onChunk: (text: string) => void,
    signal: AbortSignal,
  ): Promise<string> {
    const firstToken = new AbortController();
    const timer = setTimeout(() => firstToken.abort(), FIRST_TOKEN_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, firstToken.signal]);

    let res: Response;
    try {
      res = await this.fetchImpl(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // think: false stops reasoning models (qwen3, deepseek-r1) from thinking for seconds before answering.
        body: JSON.stringify({ model, messages, stream: true, options, think: false, keep_alive: KEEP_ALIVE }),
        signal: combined,
      });
    } catch (err) {
      clearTimeout(timer);
      if (signal.aborted) throw new OllamaError('aborted', 'Cancelled');
      if (firstToken.signal.aborted) throw new OllamaError('http', 'Ollama did not respond in time.');
      throw new OllamaError('unreachable', describeConnectionError(endpoint, err));
    }

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const detail = await res.text().catch(() => '');
      const message = parseError(detail) ?? `Ollama returned HTTP ${res.status}`;
      if (res.status === 404 && /not found/i.test(message)) {
        throw new OllamaError('model-missing', `${message}. Run: ollama pull ${model}`);
      }
      throw new OllamaError('http', message);
    }

    let full = '';
    let buffer = '';
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(timer);
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as { message?: { content?: string }; error?: string; done?: boolean };
          if (msg.error) throw new OllamaError('http', msg.error);
          const text = msg.message?.content ?? '';
          if (text) {
            full += text;
            onChunk(text);
          }
        }
      }
    } catch (err) {
      if (err instanceof OllamaError) throw err;
      if (signal.aborted) throw new OllamaError('aborted', 'Cancelled');
      throw new OllamaError('http', `Stream interrupted: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    return full;
  }

  /** Load the model into memory without generating anything (an empty chat does exactly that). */
  async warm(endpoint: string, model: string): Promise<void> {
    const res = await this.fetchImpl(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [], keep_alive: KEEP_ALIVE }),
      signal: AbortSignal.timeout(FIRST_TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    await res.text();
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

/** Use the configured model when installed; otherwise fall back to the first installed one. */
export function resolveModel(configured: string, models: OllamaModel[]): { model?: string; missing: boolean } {
  if (configured) {
    const found = models.find((m) => m.name === configured || m.name === `${configured}:latest`);
    if (found) return { model: found.name, missing: false };
    return { model: undefined, missing: true };
  }
  return { model: models[0]?.name, missing: false };
}

function parseError(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: string }).error;
  } catch {
    return body.trim() || undefined;
  }
}

function describeConnectionError(endpoint: string, err: unknown): string {
  const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
  if (/ECONNREFUSED|fetch failed/i.test(cause)) {
    return `Cannot reach Ollama at ${endpoint}. Is it running? Start it with "ollama serve" or the Ollama app.`;
  }
  if (/abort|timeout/i.test(cause)) return `Ollama at ${endpoint} did not answer within ${STATUS_TIMEOUT_MS / 1000}s.`;
  return `Cannot reach Ollama at ${endpoint}: ${cause}`;
}
