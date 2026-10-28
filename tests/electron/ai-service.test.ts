import { describe, expect, it } from 'vitest';
import { AiService } from '../../electron/ai-service';
import type { GroqClient } from '../../electron/groq-client';
import type { HistoryStore } from '../../electron/history-store';
import type { Logger } from '../../electron/logger';
import { OllamaClient, OllamaError } from '../../electron/ollama-client';
import type { AiEvent } from '../../shared/ipc';
import { DEFAULT_SETTINGS, Settings } from '../../shared/settings';

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
