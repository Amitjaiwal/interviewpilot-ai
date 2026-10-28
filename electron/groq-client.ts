import type { OllamaModel, OllamaStatus } from '../shared/ipc';
import { OllamaChatOptions, OllamaError, OllamaMessage } from './ollama-client';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Used when no model is configured, best first. Groq changes its free lineup
 * often, so the first one the key can actually use wins.
 */
export const GROQ_PREFERRED_MODELS = [
  // Measured October 2026: full short answer in ~0.5 s, accurate, and the only one
  // that did not invent experience missing from the resume.
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'qwen/qwen3-32b',
  'llama-3.1-8b-instant',
];

const STATUS_TIMEOUT_MS = 5000;
/** Groq usually answers in well under a second; past this, the local fallback is the better bet. */
const FIRST_TOKEN_TIMEOUT_MS = 15_000;
const REASONING_HEADROOM = 512;
/** Speech, moderation and agent models in the list cannot answer chat questions. */
const NON_CHAT = /whisper|tts|guard|playai|orpheus|compound|allam/i;

/**
 * Talks to Groq's OpenAI-compatible API. Main process only: the API key is
 * passed in per call and never stored here or sent to the renderer.
 */
export class GroqClient {
  /** Models the key could use at the last status check, to pick a default without a request. */
  private available: string[] = [];

  constructor(
    private readonly baseUrl = GROQ_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async status(apiKey: string, configuredModel: string): Promise<OllamaStatus> {
    const base: OllamaStatus = { reachable: false, endpoint: this.baseUrl, models: [], modelMissing: false };
    if (!apiKey) return { ...base, error: 'Add your free Groq API key (console.groq.com → API Keys).' };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
    } catch (err) {
      return { ...base, error: describeConnectionError(err) };
    }
    if (!res.ok) return { ...base, error: await describeHttpError(res) };
    const body = (await res.json()) as { data?: { id: string; active?: boolean; context_window?: number }[] };
    const models: OllamaModel[] = (body.data ?? [])
      .filter((m) => m.active !== false && !NON_CHAT.test(m.id))
      .map((m) => ({ name: m.id, sizeBytes: 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.available = models.map((m) => m.name);
    const missing = !!configuredModel && !this.available.includes(configuredModel);
    return {
      ...base,
      reachable: true,
      models,
      activeModel: missing ? undefined : this.pickModel(configuredModel),
      modelMissing: missing,
      error: missing ? `Groq no longer offers "${configuredModel}". Pick another model.` : undefined,
    };
  }

  /** The configured model, else the best preferred one seen at the last status check. */
  pickModel(configured: string): string {
    if (configured) return configured;
    return GROQ_PREFERRED_MODELS.find((m) => this.available.includes(m)) ?? GROQ_PREFERRED_MODELS[0];
  }

  /** Streams a chat completion like OllamaClient.chat, mapping failures to OllamaError codes. */
  async chat(
    apiKey: string,
    model: string,
    messages: OllamaMessage[],
    options: OllamaChatOptions,
    onChunk: (text: string) => void,
    signal: AbortSignal,
  ): Promise<string> {
    if (!apiKey) throw new OllamaError('invalid', 'No Groq API key set. Add one in Settings.');
    const firstToken = new AbortController();
    const timer = setTimeout(() => firstToken.abort(), FIRST_TOKEN_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, firstToken.signal]);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          temperature: options.temperature,
          max_completion_tokens: options.num_predict,
          ...reasoningParams(model, options.num_predict),
        }),
        signal: combined,
      });
    } catch (err) {
      clearTimeout(timer);
      if (signal.aborted) throw new OllamaError('aborted', 'Cancelled');
      if (firstToken.signal.aborted) throw new OllamaError('http', 'Groq did not respond in time.');
      throw new OllamaError('unreachable', describeConnectionError(err));
    }

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const message = await describeHttpError(res);
      throw new OllamaError(res.status === 404 ? 'model-missing' : 'http', message);
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
        // Server-sent events: one "data: {json}" line per delta, "data: [DONE]" at the end.
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return full;
          const msg = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
          if (msg.error) throw new OllamaError('http', msg.error.message ?? 'Groq reported an error');
          const text = msg.choices?.[0]?.delta?.content ?? '';
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
}

/**
 * Reasoning models think before answering; keep that minimal and out of the reply.
 * gpt-oss cannot skip reasoning entirely, and its hidden reasoning tokens count
 * toward the length limit, so it gets headroom or answers are cut off mid-sentence.
 */
export function reasoningParams(model: string, maxTokens?: number): Record<string, unknown> {
  if (/gpt-oss/i.test(model)) {
    return {
      reasoning_effort: 'low',
      include_reasoning: false,
      ...(maxTokens ? { max_completion_tokens: maxTokens + REASONING_HEADROOM } : {}),
    };
  }
  if (/qwen3/i.test(model)) return { reasoning_effort: 'none' };
  return {};
}

async function describeHttpError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  let detail = body.trim();
  try {
    detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail;
  } catch {
    // Not JSON: keep the raw text.
  }
  if (res.status === 401) return 'Groq rejected the API key. Check it in Settings.';
  if (res.status === 429) {
    const wait = res.headers.get('retry-after');
    return `Groq free-tier limit reached${wait ? `; try again in ${wait} s` : ''}.`;
  }
  return `Groq returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`;
}

function describeConnectionError(err: unknown): string {
  const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
  if (/abort|timeout/i.test(cause)) return 'Groq did not answer in time. Check your internet connection.';
  return `Cannot reach Groq (${cause}). Check your internet connection.`;
}
