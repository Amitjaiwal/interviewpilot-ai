import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GroqClient, reasoningParams } from '../../electron/groq-client';
import { OllamaError } from '../../electron/ollama-client';

/** A fake Groq server: OpenAI-style /models and streaming /chat/completions. */
const KEY = 'gsk_test_key_0123456789abcdef';
let server: Server;
let baseUrl: string;
let lastBody: Record<string, unknown> | null = null;

function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }));
  }
  if (req.url === '/models') {
    return res.end(
      JSON.stringify({
        data: [
          { id: 'whisper-large-v3', active: true },
          { id: 'llama-3.1-8b-instant', active: true },
          { id: 'openai/gpt-oss-20b', active: true },
          { id: 'retired-model', active: false },
        ],
      }),
    );
  }
  if (req.url === '/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastBody = JSON.parse(body);
      if (lastBody!['model'] === 'rate-limited') {
        res.statusCode = 429;
        res.setHeader('retry-after', '7');
        return res.end(JSON.stringify({ error: { message: 'Rate limit reached' } }));
      }
      res.setHeader('Content-Type', 'text/event-stream');
      const events = ['Hash', 'Map is ', 'not thread-safe.'].map(
        (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      );
      // Split an event across writes to exercise buffering.
      res.write(events[0].slice(0, 12));
      res.write(events[0].slice(12) + events[1]);
      res.write(events[2]);
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('GroqClient.status', () => {
  it('lists active chat models and picks the best preferred one', async () => {
    const client = new GroqClient(baseUrl);
    const s = await client.status(KEY, '');
    expect(s.reachable).toBe(true);
    expect(s.models.map((m) => m.name)).toEqual(['llama-3.1-8b-instant', 'openai/gpt-oss-20b']);
    expect(s.activeModel).toBe('openai/gpt-oss-20b');
    expect(client.pickModel('')).toBe('openai/gpt-oss-20b');
  });

  it('asks for a key when none is set, without calling Groq', async () => {
    const s = await new GroqClient('http://127.0.0.1:9').status('', '');
    expect(s.reachable).toBe(false);
    expect(s.error).toContain('console.groq.com');
  });

  it('reports a rejected key', async () => {
    const s = await new GroqClient(baseUrl).status('gsk_wrong_key_0123456789', '');
    expect(s.reachable).toBe(false);
    expect(s.error).toContain('rejected the API key');
  });

  it('flags a configured model Groq no longer offers', async () => {
    const s = await new GroqClient(baseUrl).status(KEY, 'gone-model');
    expect(s.modelMissing).toBe(true);
    expect(s.activeModel).toBeUndefined();
  });
});

describe('GroqClient.chat', () => {
  it('streams server-sent events and returns the full text', async () => {
    const chunks: string[] = [];
    const text = await new GroqClient(baseUrl).chat(
      KEY,
      'openai/gpt-oss-20b',
      [{ role: 'user', content: 'hi' }],
      { temperature: 0.4, num_predict: 300 },
      (c) => chunks.push(c),
      new AbortController().signal,
    );
    expect(text).toBe('HashMap is not thread-safe.');
    expect(chunks).toEqual(['Hash', 'Map is ', 'not thread-safe.']);
    expect(lastBody).toEqual(
      // 300 for the answer plus headroom for gpt-oss's hidden reasoning.
      expect.objectContaining({ stream: true, max_completion_tokens: 812, reasoning_effort: 'low', include_reasoning: false }),
    );
  });

  it('explains the free-tier limit on HTTP 429', async () => {
    const err = await new GroqClient(baseUrl)
      .chat(KEY, 'rate-limited', [], {}, () => undefined, new AbortController().signal)
      .catch((e) => e);
    expect(err).toBeInstanceOf(OllamaError);
    expect((err as OllamaError).message).toBe('Groq free-tier limit reached; try again in 7 s.');
  });

  it('reports a refused connection as unreachable', async () => {
    const err = await new GroqClient('http://127.0.0.1:9')
      .chat(KEY, 'x', [], {}, () => undefined, new AbortController().signal)
      .catch((e) => e);
    expect((err as OllamaError).code).toBe('unreachable');
  });
});

describe('reasoningParams', () => {
  it('keeps reasoning minimal only for models that support the parameters', () => {
    expect(reasoningParams('qwen/qwen3-32b')).toEqual({ reasoning_effort: 'none' });
    expect(reasoningParams('llama-3.3-70b-versatile')).toEqual({});
  });
});
