import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OllamaClient, OllamaError, resolveModel } from '../../electron/ollama-client';

/** A fake Ollama server implementing the endpoints the client uses. */
let server: Server;
let endpoint: string;
let lastChatBody: { model: string; stream: boolean; messages: unknown[] } | null = null;

function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.9.0' }));
  if (req.url === '/api/tags') {
    return res.end(
      JSON.stringify({ models: [{ name: 'qwen2.5:7b', size: 4_700_000_000, details: { parameter_size: '7.6B' } }] }),
    );
  }
  if (req.url === '/api/chat') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastChatBody = JSON.parse(body);
      if (lastChatBody!.model !== 'qwen2.5:7b') {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: `model "${lastChatBody!.model}" not found, try pulling it first` }));
      }
      res.setHeader('Content-Type', 'application/x-ndjson');
      const parts = ['Hash', 'Map is ', 'not thread-safe.'];
      let i = 0;
      const tick = () => {
        if (i < parts.length) {
          // Split one JSON line across two writes to exercise buffering.
          const line = JSON.stringify({ message: { role: 'assistant', content: parts[i++] }, done: false }) + '\n';
          res.write(line.slice(0, 10));
          res.write(line.slice(10));
          setTimeout(tick, 5);
        } else {
          res.end(JSON.stringify({ done: true }) + '\n');
        }
      };
      tick();
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('OllamaClient.status', () => {
  it('reports version, models and the active model', async () => {
    const s = await new OllamaClient().status(endpoint, '');
    expect(s.reachable).toBe(true);
    expect(s.version).toBe('0.9.0');
    expect(s.models.map((m) => m.name)).toEqual(['qwen2.5:7b']);
    expect(s.activeModel).toBe('qwen2.5:7b');
    expect(s.modelMissing).toBe(false);
  });

  it('flags a configured model that is not installed', async () => {
    const s = await new OllamaClient().status(endpoint, 'llama3.1:8b');
    expect(s.modelMissing).toBe(true);
    expect(s.error).toContain('ollama pull llama3.1:8b');
  });

  it('reports an unreachable server without throwing', async () => {
    const s = await new OllamaClient().status('http://127.0.0.1:9', '');
    expect(s.reachable).toBe(false);
    expect(s.error).toMatch(/Cannot reach Ollama/);
  });
});

describe('OllamaClient.chat', () => {
  it('streams chunks and returns the full text', async () => {
    const chunks: string[] = [];
    const text = await new OllamaClient().chat(
      endpoint,
      'qwen2.5:7b',
      [{ role: 'user', content: 'hi' }],
      { temperature: 0.2 },
      (c) => chunks.push(c),
      new AbortController().signal,
    );
    expect(text).toBe('HashMap is not thread-safe.');
    expect(chunks).toEqual(['Hash', 'Map is ', 'not thread-safe.']);
    expect(lastChatBody?.stream).toBe(true);
  });

  it('maps a 404 model error to model-missing', async () => {
    const err = await new OllamaClient()
      .chat(endpoint, 'missing:1b', [], {}, () => undefined, new AbortController().signal)
      .catch((e) => e);
    expect(err).toBeInstanceOf(OllamaError);
    expect((err as OllamaError).code).toBe('model-missing');
  });

  it('reports cancellation as aborted', async () => {
    const controller = new AbortController();
    const promise = new OllamaClient().chat(endpoint, 'qwen2.5:7b', [], {}, () => controller.abort(), controller.signal);
    const err = await promise.catch((e) => e);
    expect((err as OllamaError).code).toBe('aborted');
  });

  it('reports a refused connection as unreachable', async () => {
    const err = await new OllamaClient()
      .chat('http://127.0.0.1:9', 'x', [], {}, () => undefined, new AbortController().signal)
      .catch((e) => e);
    expect((err as OllamaError).code).toBe('unreachable');
  });
});

describe('resolveModel', () => {
  const models = [{ name: 'llama3:latest', sizeBytes: 1 }, { name: 'qwen2.5:7b', sizeBytes: 1 }];

  it('matches names with an implicit :latest tag', () => {
    expect(resolveModel('llama3', models)).toEqual({ model: 'llama3:latest', missing: false });
  });

  it('falls back to the first installed model when none is configured', () => {
    expect(resolveModel('', models).model).toBe('llama3:latest');
    expect(resolveModel('', [])).toEqual({ model: undefined, missing: false });
  });
});
