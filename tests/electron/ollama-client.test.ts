import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OllamaClient, OllamaError, isOllamaInstalled, resolveModel } from '../../electron/ollama-client';

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
  if (req.url === '/api/pull') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { model } = JSON.parse(body) as { model: string };
      if (model === 'denied:1b') {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: 'pull model manifest: 500' }));
      }
      if (model === 'bad:1b') return res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n');
      if (model === 'cut:1b') return res.end(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      const lines = [
        { status: 'pulling manifest' },
        { status: 'pulling abc123', completed: 1000, total: 4000 },
        { status: 'pulling abc123', completed: 4000, total: 4000 },
        { status: 'success' },
      ].map((l) => JSON.stringify(l) + '\n');
      // Split a line across two writes to exercise buffering.
      res.write(lines[0].slice(0, 5));
      res.write(lines[0].slice(5));
      res.end(lines.slice(1).join(''));
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

  it('tells a first-time user how to get Ollama, without terminal commands', async () => {
    // A port that really refuses connections, as when Ollama is not installed. (fetch blocks port 9 outright.)
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((r) => closed.close(() => r()));

    const s = await new OllamaClient().status(`http://127.0.0.1:${port}`, '');
    expect(s.error).toContain('ollama.com/download');
    expect(s.error).not.toContain('ollama serve');
  });
});

describe('OllamaClient.pull', () => {
  const pull = (model: string, signal = new AbortController().signal, target = endpoint) => {
    const progress: { status: string; completed?: number; total?: number }[] = [];
    return new OllamaClient().pull(target, model, (p) => progress.push(p), signal).then(
      () => ({ progress, error: undefined }),
      (error: OllamaError) => ({ progress, error }),
    );
  };

  it('reports progress lines and finishes on success', async () => {
    const { progress, error } = await pull('qwen2.5:7b');
    expect(error).toBeUndefined();
    expect(progress.map((p) => p.status)).toEqual(['pulling manifest', 'pulling abc123', 'pulling abc123', 'success']);
    expect(progress[1]).toEqual({ status: 'pulling abc123', completed: 1000, total: 4000 });
  });

  it('reports an error line from Ollama', async () => {
    expect((await pull('bad:1b')).error?.message).toContain('file does not exist');
  });

  it('reports an error status from Ollama', async () => {
    expect((await pull('denied:1b')).error?.message).toContain('pull model manifest: 500');
  });

  it('treats a stream that ends without "success" as a failure', async () => {
    expect((await pull('cut:1b')).error?.message).toContain('ended early');
  });

  it('reports a refused connection as unreachable', async () => {
    expect((await pull('qwen2.5:7b', undefined, 'http://127.0.0.1:9')).error?.code).toBe('unreachable');
  });

  it('reports cancellation as aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await pull('qwen2.5:7b', controller.signal)).error?.code).toBe('aborted');
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

describe('isOllamaInstalled', () => {
  it('looks in the install folder and on the PATH', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ip-ollama-'));
    try {
      expect(isOllamaInstalled({ LOCALAPPDATA: dir, PATH: dir })).toBe(false);
      expect(isOllamaInstalled({})).toBe(false);

      const installed = path.join(dir, 'Programs', 'Ollama');
      mkdirSync(installed, { recursive: true });
      writeFileSync(path.join(installed, 'ollama.exe'), '');
      expect(isOllamaInstalled({ LOCALAPPDATA: dir })).toBe(true);

      const onPath = path.join(dir, 'custom');
      mkdirSync(onPath);
      writeFileSync(path.join(onPath, 'ollama.exe'), '');
      expect(isOllamaInstalled({ PATH: ['C:\\nowhere', onPath].join(path.delimiter) })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
