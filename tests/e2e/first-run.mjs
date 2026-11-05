// What a new user sees before local AI is set up, in the real app, against a fake Ollama.
//
//   npm run build && npm run test:first-run [-- <screenshot-folder>]
//   set E2E_APP_EXE to test a packaged or installed exe instead
//
// Walks through: Ollama missing (banner and step 1), Ollama running with no models
// (step 2), cancelling a download, and finishing it. No real download happens.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { click, connect, launch, reporter, sleep, waitFor } from './harness.mjs';

const SHOTS = process.argv[2];
const PORT = 11599;
const { pass, fail, finish } = reporter();

let modelInstalled = false;
/** The first download stops halfway and waits, so the test can look at it and cancel it. */
let holdHalfway = true;
let downloadsCut = 0;

const server = createServer((req, res) => {
  const json = (body) => res.end(JSON.stringify(body));
  if (req.url === '/api/version') return json({ version: '0.0-fake' });
  if (req.url === '/api/tags') return json({ models: modelInstalled ? [{ name: 'qwen2.5:7b', size: 4_700_000_000 }] : [] });
  if (req.url === '/api/pull') {
    const line = (o) => res.write(JSON.stringify(o) + '\n');
    line({ status: 'pulling manifest' });
    line({ status: 'pulling abc123', completed: 2_350_000_000, total: 4_700_000_000 });
    if (holdHalfway) {
      res.on('close', () => downloadsCut++);
      return; // keep the response open until the client hangs up
    }
    setTimeout(() => {
      line({ status: 'pulling abc123', completed: 4_700_000_000, total: 4_700_000_000 });
      line({ status: 'verifying sha256 digest' });
      modelInstalled = true;
      res.end(JSON.stringify({ status: 'success' }) + '\n');
    }, 300);
    return;
  }
  res.statusCode = 404;
  res.end();
});

// As on a PC without Ollama, even if this one has it: nothing to find in the install folder or on the PATH.
const noOllama = mkdtempSync(join(tmpdir(), 'ip-no-ollama-'));
const app = launch([], 9336, {
  env: { LOCALAPPDATA: noOllama, PATH: (process.env.PATH ?? '').split(delimiter).filter((p) => !/ollama/i.test(p)).join(delimiter) },
});

try {
  const cdp = await connect(app.port);
  const { evaluate } = cdp;
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  const shot = async (name) => {
    if (!SHOTS) return;
    await sleep(400);
    await cdp.screenshot(join(SHOTS, `first-run-${name}.png`));
  };
  await waitFor(() => evaluate(`!!document.querySelector('.footer kbd')`), 30_000, 'UI to render');

  // ------------------------------------------------- Ollama not installed
  await evaluate(`window.interviewPilot.settings.update({ ollama: { endpoint: 'http://127.0.0.1:${PORT}', model: '' } })`);
  await evaluate(click('.tabs button', 'Settings'));
  await waitFor(() => evaluate(`document.querySelector('app-settings .setup')?.textContent.includes('Step 1 of 2')`), 10_000, 'step 1');
  await evaluate(click('.tabs button', 'Live'));
  const banner = await text('.setup-banner');
  if (banner.includes('one-time setup')) pass('Live tab offers the setup while Ollama is missing');
  else fail('setup banner', banner);
  await shot('banner');

  await evaluate(click('.setup-banner'));
  const onSettings = await waitFor(() => evaluate(`document.querySelector('app-settings:not([hidden]) .setup')?.textContent ?? null`), 5000, 'banner to open Settings');
  const href = await evaluate(`document.querySelector('app-settings .setup a')?.href`);
  if (onSettings.includes('Step 1 of 2') && href === 'https://ollama.com/download/windows') pass('step 1 links to the Ollama download', href);
  else fail('step 1', `${onSettings} | ${href}`);
  await shot('step1');

  // Nothing shown to a first-time user may ask for a terminal.
  const shown = await text('app-settings details');
  if (/ollama (serve|pull)|npm run/i.test(shown)) fail('no terminal commands in the setup', shown);
  else pass('no terminal commands in the setup');

  // ---------------------------------------- Ollama installed, no models yet
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await evaluate(click('app-settings .setup button', 'Check again'));
  await waitFor(() => evaluate(`document.querySelector('app-settings .setup')?.textContent.includes('Step 2 of 2')`), 10_000, 'step 2');
  pass('"Check again" moves on to step 2 once Ollama answers');
  await shot('step2');

  // -------------------------------------------------- cancelled download
  await evaluate(click('app-settings .setup button', 'Download model'));
  const progress = await waitFor(
    () => evaluate(`(() => { const t = document.querySelector('app-settings .setup')?.textContent ?? ''; return t.includes('50%') ? t : null; })()`),
    10_000,
    'download progress',
  );
  if (/2\.4 GB of 4\.7 GB/.test(progress)) pass('download shows percent and size');
  else fail('download progress', progress);
  await shot('downloading');

  await evaluate(click('app-settings .setup button', 'Cancel'));
  await waitFor(() => evaluate(`[...document.querySelectorAll('app-settings .setup button')].some(b => b.textContent.includes('Download model'))`), 10_000, 'cancel');
  const errorAfterCancel = await evaluate(`document.querySelector('app-settings .setup .error-box')?.textContent ?? null`);
  await waitFor(async () => downloadsCut === 1, 5000, 'the connection to Ollama to close');
  if (errorAfterCancel === null) pass('cancel stops the download without an error');
  else fail('cancel', errorAfterCancel);

  // --------------------------------------------------- finished download
  holdHalfway = false;
  await evaluate(click('app-settings .setup button', 'Download model'));
  await waitFor(() => evaluate(`!document.querySelector('app-settings .setup')`), 15_000, 'setup to finish');
  const pill = await text('.pill.as-btn');
  await evaluate(click('.tabs button', 'Live'));
  const stillBanner = await evaluate(`!!document.querySelector('.setup-banner')`);
  if (pill.includes('qwen2.5:7b') && !stillBanner) pass('after the download the app is ready to answer', pill.trim());
  else fail('after download', `${pill} banner=${stillBanner}`);
  await shot('done');

  cdp.close();
} catch (err) {
  fail('first-run walkthrough', err instanceof Error ? err.message : String(err));
} finally {
  server.closeAllConnections();
  server.close();
  await app.close();
  rmSync(noOllama, { recursive: true, force: true });
  finish();
}
