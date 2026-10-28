// Shared helpers for the end-to-end scripts: launch the built Electron app with
// a throwaway data folder and drive its window over the Chrome DevTools Protocol.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronPath from 'electron';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(250);
  }
}

/**
 * Launch the app; extra Chromium switches go in `args`. Set E2E_APP_EXE to a
 * packaged InterviewPilot AI.exe (npm run test:e2e:packaged) to test the
 * installed build instead of the project folder.
 */
export function launch(args = [], port = 9333) {
  const userData = mkdtempSync(join(tmpdir(), 'ip-e2e-'));
  const env = { ...process.env, INTERVIEWPILOT_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_START_URL;
  const exe = process.env.E2E_APP_EXE;
  const proc = spawn(exe || electronPath, [...(exe ? [] : ['.']), `--remote-debugging-port=${port}`, ...args], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return {
    port,
    userData,
    pid: proc.pid,
    async close() {
      proc.kill();
      await sleep(1000);
      if (process.env.E2E_KEEP_DATA) console.log(`Data folder kept: ${userData}`);
      else rmSync(userData, { recursive: true, force: true });
    },
  };
}

/** Minimal CDP client over Node's built-in WebSocket. */
export async function connect(port) {
  const target = await waitFor(
    async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((t) => t.type === 'page' && t.url.startsWith('file://'));
    },
    20_000,
    'the app window',
  );
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
    }
    return res.result?.result?.value;
  };
  const screenshot = async (file) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  };
  return { send, evaluate, screenshot, close: () => ws.close() };
}

/** Expression: click the first visible element matching `selector` whose text includes `text`. */
export const click = (selector, text) =>
  `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
     const el = els.find(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'} && e.offsetParent !== null);
     if (!el) return false; el.click(); return true; })()`;

/** Expression: set a visible textarea/input's value the way typing would, so ngModel sees it. */
export const type = (selector, text) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.offsetParent !== null);
     if (!el) return false; el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;

/** Collects PASS/FAIL/SKIP lines and sets the exit code. */
export function reporter() {
  const lines = [];
  let failed = false;
  return {
    pass: (name, detail = '') => lines.push(`PASS ${name}${detail ? ` - ${detail}` : ''}`),
    fail: (name, detail) => {
      failed = true;
      lines.push(`FAIL ${name} - ${detail}`);
    },
    skip: (name, detail) => lines.push(`SKIP ${name} - ${detail}`),
    finish() {
      console.log('\n' + lines.join('\n'));
      process.exit(failed ? 1 : 0);
    },
  };
}
