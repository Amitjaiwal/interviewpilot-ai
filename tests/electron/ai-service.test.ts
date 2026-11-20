import { describe, expect, it } from 'vitest';
import { AiService } from '../../electron/ai-service';
import type { GroqClient } from '../../electron/groq-client';
import type { HistoryStore } from '../../electron/history-store';
import type { Logger } from '../../electron/logger';
import { OllamaClient, OllamaError } from '../../electron/ollama-client';
import type { AiEvent } from '../../shared/ipc';
import { DEFAULT_SETTINGS, RECOMMENDED_OLLAMA_MODEL, Settings } from '../../shared/settings';

const groqSettings: Settings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, provider: 'groq' } };

function setup(groqChat: GroqClient['chat']) {
  const events: AiEvent[] = [];
  const ollama = {
    status: async () => ({ reachable: true, endpoint: '', models: [], activeModel: 'qwen3:8b', modelMissing: false }),
    chat: async (_e: string, _m: string, _msgs: unknown, _o: unknown, onChunk: (t: string) => void) => {
      onChunk('local answer');
      return 'local answer';
    },
  } as unknown as OllamaClient;
  const groq = { pickModel: () => 'openai/gpt-oss-120b', chat: groqChat } as unknown as GroqClient;
  const log = { info: () => undefined, warn: () => undefined } as unknown as Logger;
  const history = { appendExchange: () => undefined } as unknown as HistoryStore;
  const service = new AiService(ollama, groq, () => 'gsk_key', () => groqSettings, history, log, (e) => events.push(e));
  const finished = () =>
    new Promise<void>((resolve) => {
      const check = () => (events.some((e) => e.type === 'done' || e.type === 'error') ? resolve() : setTimeout(check, 5));
      check();
    });
  return { service, events, finished };
}

describe('AiService with Groq', () => {
  it('streams the Groq answer', async () => {
    const { service, events, finished } = setup(async (_k, _m, _msgs, _o, onChunk) => {
      onChunk('fast answer');
      return 'fast answer';
    });
    service.start({ mode: 'answer', input: 'What is a HashMap?' });
    await finished();
    expect(events.find((e) => e.type === 'start')).toEqual(expect.objectContaining({ model: 'openai/gpt-oss-120b (Groq)' }));
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'done', text: 'fast answer' }));
  });

  it('answers locally when Groq fails before sending any text', async () => {
    const { service, events, finished } = setup(async () => {
      throw new OllamaError('http', 'Groq free-tier limit reached.');
    });
    service.start({ mode: 'answer', input: 'What is a HashMap?' });
    await finished();
    expect(events.filter((e) => e.type === 'start').map((e) => (e as { model: string }).model)).toEqual([
      'openai/gpt-oss-120b (Groq)',
      'qwen3:8b (Groq unavailable, local)',
    ]);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'done', text: 'local answer' }));
  });

  it('reports a failure in the middle of an answer instead of starting over locally', async () => {
    const { service, events, finished } = setup(async (_k, _m, _msgs, _o, onChunk) => {
      onChunk('half an ');
      throw new OllamaError('http', 'Stream interrupted');
    });
    service.start({ mode: 'answer', input: 'What is a HashMap?' });
    await finished();
    expect(events.filter((e) => e.type === 'start')).toHaveLength(1);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'error', message: 'Stream interrupted' }));
  });
});

describe('AiService.pullRecommendedModel', () => {
  type Pull = OllamaClient['pull'];

  function pullSetup(pull: Pull) {
    const installed = { reachable: true, endpoint: '', models: [{ name: 'qwen2.5:7b', sizeBytes: 1 }], activeModel: 'qwen2.5:7b', modelMissing: false };
    const client = { status: async () => installed, pull } as unknown as OllamaClient;
    const log = { info: () => undefined, warn: () => undefined } as unknown as Logger;
    return new AiService(client, {} as GroqClient, () => '', () => DEFAULT_SETTINGS, {} as HistoryStore, log, () => undefined);
  }

  it('downloads the recommended model from the configured endpoint and returns the new status', async () => {
    const seen: string[] = [];
    const service = pullSetup(async (endpoint, model) => void seen.push(endpoint, model));
    const status = await service.pullRecommendedModel(() => undefined);
    expect(seen).toEqual([DEFAULT_SETTINGS.ollama.endpoint, RECOMMENDED_OLLAMA_MODEL]);
    expect(status.activeModel).toBe('qwen2.5:7b');
  });

  it('forwards each new stage at once but thins out repeated progress for the same stage', async () => {
    const service = pullSetup(async (_e, _m, onProgress) => {
      onProgress({ status: 'pulling manifest' });
      for (let i = 1; i <= 100; i++) onProgress({ status: 'pulling abc', completed: i, total: 100 });
      onProgress({ status: 'success' });
    });
    const sent: string[] = [];
    await service.pullRecommendedModel((p) => sent.push(p.status));
    expect(sent).toEqual(['pulling manifest', 'pulling abc', 'success']);
  });

  it('resolves normally when cancelled, and a new download can start afterwards', async () => {
    const service = pullSetup(
      (_e, _m, _p, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new OllamaError('aborted', 'Cancelled')))),
    );
    const running = service.pullRecommendedModel(() => undefined);
    service.cancelPull();
    await expect(running).resolves.toBeDefined();
    const again = service.pullRecommendedModel(() => undefined);
    service.cancelAll();
    await expect(again).resolves.toBeDefined();
  });

  it('refuses a second download while one is running', async () => {
    const service = pullSetup((_e, _m, _p, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve())));
    const running = service.pullRecommendedModel(() => undefined);
    await expect(service.pullRecommendedModel(() => undefined)).rejects.toThrow('already downloading');
    service.cancelPull();
    await running;
  });

  it('passes failures on to the caller', async () => {
    const service = pullSetup(async () => {
      throw new OllamaError('http', 'disk full');
    });
    await expect(service.pullRecommendedModel(() => undefined)).rejects.toThrow('disk full');
  });
});
