// First-run setup and the AI provider scenarios, in the real app.
//
//   npm run build && npm run test:onboarding [-- <screenshot-folder>]
//   set E2E_APP_EXE to test a packaged or installed exe instead
//
// In the project build, Groq is a local fake server, so valid keys and lost connections can be
// tested. The installed app ignores that override on purpose (it would be a way to send someone's
// key elsewhere), so with E2E_APP_EXE only what needs no valid key runs, against the real Groq API.
// Ollama checks use the real Ollama on this PC and are skipped if it is not running.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { click, connect, launch, reporter, sleep, type, waitFor } from './harness.mjs';

const SHOTS = process.argv[2];
const PACKAGED = !!process.env.E2E_APP_EXE;
const GROQ_PORT = 11597;
const CLOSED_PORT = 11598;
// Obviously not real keys, and not shaped like one to the no-secrets check.
const GOOD_KEY = 'gsk_fake_key_for_tests_only_good';
const BAD_KEY = 'gsk_fake_key_for_tests_only_bad0';

const { pass, fail, skip, finish } = reporter();
const check = (ok, name, detail = '') => (ok ? pass(name) : fail(name, detail || 'check failed'));

// ------------------------------------------------------------- fake Groq
const groqRequests = [];
let lastChatModel = '';
const groq = createServer((req, res) => {
  groqRequests.push(req.url);
  if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }));
  }
  if (req.url === '/models') {
    // In no particular order: the app has to choose by its own preference.
    return res.end(JSON.stringify({ data: ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'].map((id) => ({ id, active: true })) }));
  }
  if (req.url === '/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastChatModel = JSON.parse(body).model;
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello from ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fake Groq' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});
const groqUp = () => new Promise((r) => groq.listen(GROQ_PORT, '127.0.0.1', r));
const groqDown = () =>
  new Promise((r) => {
    groq.closeAllConnections();
    groq.close(r);
  });

// -------------------------------------------------------------- helpers
const baseEnv = { INTERVIEWPILOT_GROQ_URL: `http://127.0.0.1:${GROQ_PORT}` };
let nextPort = 9340;

/** Run one scenario against its own app instance. */
async function scenario(name, options, body) {
  const app = launch([], nextPort++, { newUser: true, keepData: true, ...options, env: { ...baseEnv, ...options.env } });
  let cdp;
  try {
    cdp = await connect(app.port);
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.footer kbd')`), 30_000, 'the app to render');
    await body(ui(cdp), app);
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  } finally {
    cdp?.close();
    await app.close();
  }
  return app.userData;
}

function ui(cdp) {
  const { evaluate } = cdp;
  const self = {
    evaluate,
    text: (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`),
    has: (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
    press: async (label, scope = 'button') => {
      if (!(await evaluate(click(scope, label)))) throw new Error(`No visible "${label}" in ${scope}`);
    },
    fill: async (selector, value) => {
      if (!(await evaluate(type(selector, value)))) throw new Error(`No visible ${selector}`);
    },
    choose: (selector, value) =>
      evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true })); })()`),
    waitText: (selector, wanted, ms = 15_000) =>
      waitFor(() => evaluate(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').includes(${JSON.stringify(wanted)})`), ms, `"${wanted}" in ${selector}`),
    settings: () => evaluate(`window.interviewPilot.settings.get()`),
    status: () => evaluate(`window.interviewPilot.ai.status()`),
    shot: async (name) => {
      if (!SHOTS) return;
      await sleep(400);
      await cdp.screenshot(join(SHOTS, `onboarding-${name}.png`));
    },
    /** Run an AI request through the preload API and resolve with its final event and model. */
    ask: (input) =>
      evaluate(`new Promise((resolve) => {
        let model = '';
        const off = window.interviewPilot.ai.onEvent((e) => {
          if (e.type === 'start') model = e.model;
          if (e.type === 'done' || e.type === 'error') { off(); resolve({ ...e, model }); }
        });
        window.interviewPilot.ai.start(${JSON.stringify({ mode: 'explain', input, length: 'short' })});
      })`),
    openConnectStep: async () => {
      await self.press('Get started', 'app-onboarding button');
      await self.waitText('app-onboarding', 'Choose your AI');
      await self.press('Continue', 'app-onboarding button');
    },
    enterKey: async (key) => {
      await self.fill('app-onboarding input[type=password]', key);
      await self.press('Save and test', 'app-onboarding button');
    },
    /** From the connect step to the normal app. */
    finishSetup: async () => {
      await waitFor(() => evaluate(`!!document.querySelector('.actions')`), 5000, 'the connect step');
      const button = (await evaluate(click('app-onboarding .actions button', 'Skip for now'))) || (await evaluate(click('app-onboarding .actions button', 'Continue')));
      if (!button) throw new Error('No way forward from the connect step');
      await self.waitText('app-onboarding', 'Check speech recognition');
      await waitFor(() => evaluate(`!document.querySelector('app-onboarding .spinner')`), 90_000, 'the speech check');
      await self.press('Continue', 'app-onboarding .actions button');
      await self.waitText('app-onboarding', 'Start using InterviewPilot AI');
      await self.press('Start using InterviewPilot AI', 'app-onboarding button');
      await waitFor(() => evaluate(`!!document.querySelector('.tabs')`), 5000, 'the main view');
    },
  };
  return self;
}

/** Every file in the data folder, plus what the renderer can see: the key must not be in any of them. */
async function assertKeyNotExposed(u, userData, key) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(userData);
  const leaking = files.filter((f) => {
    try {
      return readFileSync(f, 'latin1').includes(key);
    } catch {
      return false; // Chromium holds a few files open exclusively
    }
  });
  check(leaking.length === 0, `key is not in plain text in any of ${files.length} data files`, leaking.join(', '));
  check(existsSync(join(userData, 'secrets.json')), 'key is stored in the encrypted secrets file');

  const seen = await u.evaluate(`Promise.all([
    window.interviewPilot.settings.get(),
    window.interviewPilot.ai.status(),
    window.interviewPilot.getDiagnostics(),
  ]).then((r) => JSON.stringify(r) + JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + document.documentElement.outerHTML)`);
  check(!seen.includes(key), 'renderer cannot read the key back (settings, status, diagnostics, storage, page)');

  const direct = await u.evaluate(`fetch('https://api.groq.com/openai/v1/models').then(() => 'allowed', () => 'blocked')`);
  check(direct === 'blocked', 'renderer cannot call Groq itself; requests stay in the main process', direct);
}

function removeData(folder) {
  rmSync(folder, { recursive: true, force: true });
}

const closedOllama = `window.interviewPilot.settings.update({ ollama: { endpoint: 'http://127.0.0.1:${CLOSED_PORT}' } })`;
const noOllamaFolder = mkdtempSync(join(tmpdir(), 'ip-no-ollama-'));
const noOllamaEnv = {
  LOCALAPPDATA: noOllamaFolder,
  PATH: (process.env.PATH ?? '').split(delimiter).filter((p) => !/ollama/i.test(p)).join(delimiter),
};
const ollamaRunning = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).then((t) => (t.models ?? []).length > 0).catch(() => false);
const ollamaOnThisPc = !!process.env.LOCALAPPDATA && existsSync(join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));

await groqUp();

// ------------------------------------- 1. Fresh install / 2. without a key
console.log('Scenario: fresh installation, without a Groq key');
removeData(
  await scenario('fresh install without a key', {}, async (u, app) => {
    check(await u.has('app-onboarding'), 'a new installation opens the first-run setup');
    check(!(await u.has('.tabs')), 'the main view stays hidden during setup');
    await u.waitText('app-onboarding', 'Welcome to InterviewPilot AI');
    const saved = JSON.parse(readFileSync(join(app.userData, 'settings.json'), 'utf8'));
    check(saved.ai.provider === 'groq' && saved.setup.onboardingDone === false, 'a new installation starts on Groq, saved to disk at once', JSON.stringify(saved.ai));
    check(!/ollama/i.test(await u.text('app-onboarding')), 'the welcome step does not ask for Ollama');
    await u.shot('1-welcome');

    await u.press('Get started', 'app-onboarding button');
    await u.waitText('app-onboarding', 'Choose your AI');
    const providers = await u.text('app-onboarding .choices');
    check(/Groq Cloud AI\s*Recommended/.test(providers), 'Groq is marked as recommended');
    check(await u.evaluate(`document.querySelector('.choice.on')?.textContent.includes('Groq')`), 'Groq is selected by default');
    await u.shot('2-provider');

    await u.press('Continue', 'app-onboarding button');
    await u.waitText('app-onboarding', 'Connect to Groq');
    const link = await u.evaluate(`document.querySelector('app-onboarding a[target=_blank]')?.href`);
    check(link === 'https://console.groq.com/keys', 'the Groq step links to console.groq.com/keys', link);
    check(/Create API Key/.test(await u.text('app-onboarding .how-to')), 'the Groq step says what to click in the console');
    check(/Ctrl\+V/.test(await u.text('app-onboarding .how-to')), 'the Groq step says how to paste, as right-click has no Paste');
    check(/Don't share it with anyone/.test(await u.text('app-onboarding')), 'the Groq step says not to share the key');
    await u.shot('3-groq-key');

    await u.finishSetup();
    await u.shot('4-main-without-key');
    check((await u.settings()).setup.onboardingDone === true, 'setup is remembered as done');
    check((await u.text('.setup-banner')).includes('one-time setup'), 'without a key, the app offers to finish the setup');
    check((await u.text('.pill.as-btn')).includes('no key'), 'the status strip says there is no key', await u.text('.pill.as-btn'));

    if (!PACKAGED) {
      const before = groqRequests.length;
      await u.evaluate(closedOllama);
      const answer = await u.ask('hello');
      check(answer.type === 'error' && answer.message.includes('No Groq API key'), 'asking for an answer explains that a key is missing', JSON.stringify(answer));
      check(groqRequests.length === before, 'without a key, nothing is sent to Groq');
    }
    const stt = await u.evaluate(`window.interviewPilot.stt.test()`);
    check(stt.engine === 'ready', 'speech recognition works without a key', stt.error);

    await u.press('Settings', '.tabs button');
    await u.waitText('app-settings', 'No API key yet');
    check(!(await u.evaluate(`[...document.querySelectorAll('app-settings .error-box')].some((b) => b.offsetParent !== null)`)), 'Settings shows no alarming error for a missing key');
    await u.shot('5-settings-no-key');
  }),
);

// -------------------------------------------------------- 3. Invalid key
console.log('Scenario: invalid Groq API key');
removeData(
  await scenario('invalid key', {}, async (u, app) => {
    await u.openConnectStep();
    await u.waitText('app-onboarding', 'Connect to Groq');
    await u.enterKey('abc');
    await u.waitText('app-onboarding .error-box', 'does not look like an API key');
    pass('a malformed key is refused before anything is sent');

    const before = groqRequests.length;
    await u.enterKey(BAD_KEY);
    await u.waitText('app-onboarding .error-box', 'Groq rejected this key', 20_000);
    pass(PACKAGED ? 'the REAL Groq API rejected a fake key, and the app says so' : 'a key Groq refuses is reported');
    await u.shot('6-invalid-key');
    check(!existsSync(join(app.userData, 'secrets.json')), 'a rejected key is not saved');
    check((await u.status()).apiKeySet === false, 'the app still reports no key');
    check(!(await u.evaluate(`[...document.querySelectorAll('app-onboarding .actions button')].some((b) => b.textContent.includes('Continue'))`)), 'setup does not offer Continue with a rejected key');
    if (PACKAGED) {
      check(groqRequests.length === before, 'the installed app ignores the test override: nothing reached the fake server');
      check((await u.status()).endpoint === 'https://api.groq.com/openai/v1', 'the installed app only talks to api.groq.com', (await u.status()).endpoint);
    }
    await u.finishSetup();
  }),
);

// --------------------------------------------------------- 4. Valid key
if (PACKAGED) {
  skip('valid key', 'needs a real key on the installed app; covered on the project build with a fake Groq');
} else {
  console.log('Scenario: valid Groq API key (fake Groq server)');
  const folder = await scenario('valid key', {}, async (u, app) => {
    await u.openConnectStep();
    await u.waitText('app-onboarding', 'Connect to Groq');
    await u.enterKey(GOOD_KEY);
    await u.waitText('app-onboarding', 'Connected to Groq', 20_000);
    pass('a valid key is tested and accepted');
    await u.shot('7-groq-connected');
    check(!(await u.has('app-onboarding input[type=password]')), 'the key field is gone once the key is saved');

    await u.press('Continue', 'app-onboarding .actions button');
    await u.waitText('app-onboarding', 'Check speech recognition');
    await u.waitText('app-onboarding', 'Speech engine is ready', 90_000);
    pass('setup verifies that the speech engine starts');
    check((await u.text('app-onboarding')).includes('Microphone found'), 'setup finds a microphone', await u.text('app-onboarding'));
    await u.shot('8-speech-check');

    await u.press('Continue', 'app-onboarding .actions button');
    await u.waitText('app-onboarding', "You're all set");
    check((await u.text('app-onboarding')).includes('Groq Cloud AI is ready'), 'the last step confirms Groq is ready');
    await u.shot('9-done');
    await u.press('Start using InterviewPilot AI', 'app-onboarding button');
    await waitFor(() => u.has('.tabs'), 5000, 'the main view');
    check(!(await u.has('.setup-banner')), 'no setup banner once connected');
    await u.waitText('.pill.as-btn', 'AI: Groq');
    pass('the status strip shows Groq');

    const answer = await u.ask('hello');
    check(answer.type === 'done' && answer.text === 'Hello from fake Groq' && /Groq/.test(answer.model), 'answers stream from Groq', JSON.stringify(answer));
    check(lastChatModel === 'openai/gpt-oss-120b', 'a new user is answered by openai/gpt-oss-120b', lastChatModel);

    // The consent text must be honest about where text goes.
    await u.press('Start', 'app-live button');
    await waitFor(() => u.has('.modal'), 5000, 'the capture notice');
    check((await u.text('.modal')).includes('sent to Groq'), 'the capture notice says text is sent to Groq');
    await u.shot('10-consent-groq');
    await u.press('Cancel', '.modal button');

    await assertKeyNotExposed(u, app.userData, GOOD_KEY);

    // Quit normally. Chromium keeps the key that protects secrets.json in memory until it writes
    // it to disk, within seconds or on quit, so a force-kill straight after saving would lose it.
    await Promise.race([u.evaluate(`window.interviewPilot.window.close()`), sleep(1000)]).catch(() => undefined);
    await sleep(2500);
  });

  console.log('Scenario: restart keeps the key and skips setup');
  await scenario('restart', { newUser: false, userData: folder }, async (u) => {
    check(!(await u.has('app-onboarding')), 'setup does not appear again after a restart');
    const status = await waitFor(async () => {
      const s = await u.status();
      return s.reachable ? s : null;
    }, 10_000, 'Groq status');
    check(status.provider === 'groq' && status.apiKeySet, 'the encrypted key is read back after a restart');
  });

  // ---------------------------------------- 5. No internet (simulated)
  console.log('Scenario: no internet connection (Groq unreachable, simulated)');
  await groqDown();
  await scenario('no internet with a saved key', { newUser: false, userData: folder, keepData: false }, async (u) => {
    await u.evaluate(closedOllama);
    await u.press('Settings', '.tabs button');
    await u.waitText('app-settings .error-box', 'Check your internet connection', 15_000);
    pass('Settings explains the connection problem');
    await u.shot('11-offline-settings');
    check((await u.text('.pill.as-btn')).includes('offline'), 'the status strip says offline');
    await u.press('Live', '.tabs button');
    check(!(await u.has('.setup-banner')), 'being offline is not presented as a setup problem');
    const answer = await u.ask('hello');
    check(answer.type === 'error' && /internet connection/i.test(answer.message), 'asking for an answer explains the connection problem', JSON.stringify(answer));
  });

  removeData(
    await scenario('no internet during setup', {}, async (u, app) => {
      await u.openConnectStep();
      await u.waitText('app-onboarding', 'Connect to Groq');
      await u.enterKey(GOOD_KEY);
      await u.waitText('app-onboarding .warn-box', 'could not be tested', 20_000);
      pass('with no internet the key is saved, with a clear warning');
      await u.shot('12-offline-setup');
      check(existsSync(join(app.userData, 'secrets.json')), 'the untested key is kept, so it need not be pasted again');
      check(await u.evaluate(`[...document.querySelectorAll('app-onboarding .actions button')].some((b) => b.textContent.includes('Continue'))`), 'setup can continue offline');

      await groqUp();
      await u.press('Test again', 'app-onboarding button');
      await u.waitText('app-onboarding', 'Connected to Groq', 15_000);
      pass('back online, "Test again" connects without pasting the key again');
    }),
  );
}

// ------------------------------------------- 6. Switching Groq to Ollama
if (!ollamaRunning) {
  skip('switching to Ollama', 'Ollama is not running on this PC');
} else {
  console.log('Scenario: switching from Groq to Ollama (real Ollama)');
  removeData(
    await scenario('switch provider', {}, async (u) => {
      await u.openConnectStep();
      await u.waitText('app-onboarding', 'Connect to Groq');
      if (!PACKAGED) {
        await u.enterKey(GOOD_KEY);
        await u.waitText('app-onboarding', 'Connected to Groq', 20_000);
      }
      await u.finishSetup();

      await u.press('Settings', '.tabs button');
      await u.choose('app-settings select', 'local');
      await u.waitText('app-settings', 'Connected to Ollama', 15_000);
      pass('switching to Ollama in Settings connects to real Ollama');
      check((await u.settings()).ai.provider === 'local', 'the choice is saved');
      await u.shot('13-switched-to-ollama');
      const answer = await u.ask('In one short sentence: what is a Java HashMap?');
      check(answer.type === 'done' && answer.text.length > 5 && !/Groq/.test(answer.model), 'answers now come from Ollama', JSON.stringify(answer).slice(0, 200));

      await u.choose('app-settings select', 'groq');
      if (PACKAGED) {
        await u.waitText('app-settings', 'No API key yet', 15_000);
        pass('switching back to Groq asks for a key again, as none was set');
      } else {
        await u.waitText('app-settings', 'Connected to Groq', 15_000);
        check((await u.status()).apiKeySet, 'switching back to Groq keeps the key');
      }
    }),
  );

  console.log('Scenario: choosing Ollama during setup (real Ollama)');
  removeData(
    await scenario('choose Ollama in setup', {}, async (u) => {
      await u.press('Get started', 'app-onboarding button');
      await u.waitText('app-onboarding', 'Choose your AI');
      await u.press('Ollama Local AI', 'app-onboarding .choice');
      await u.press('Continue', 'app-onboarding .actions button');
      await u.waitText('app-onboarding', 'Ollama is ready', 15_000);
      pass('setup detects a running Ollama with a model');
      check((await u.settings()).ai.provider === 'local', 'choosing Ollama is saved');
      await u.shot('14-ollama-ready');
      await u.finishSetup();
      await u.press('Start', 'app-live button');
      await waitFor(() => u.has('.modal'), 5000, 'the capture notice');
      check((await u.text('.modal')).includes('nothing is sent to the internet'), 'with Ollama, the capture notice says nothing is sent');
    }),
  );
}

// ---------------------------------------------- 7. Ollama not installed
console.log('Scenario: Ollama not installed');
removeData(
  await scenario('Ollama not installed', { env: noOllamaEnv }, async (u) => {
    await u.evaluate(closedOllama);
    await u.press('Get started', 'app-onboarding button');
    await u.waitText('app-onboarding', 'Choose your AI');
    await u.press('Ollama Local AI', 'app-onboarding .choice');
    await u.press('Continue', 'app-onboarding .actions button');
    await u.waitText('app-onboarding', 'Step 1 of 2: install Ollama', 15_000);
    pass('choosing Ollama without it installed shows how to get it');
    const link = await u.evaluate(`document.querySelector('app-onboarding .setup a')?.href`);
    check(link === 'https://ollama.com/download/windows', 'the step links to the Ollama download', link);
    await u.shot('15-ollama-missing');

    await u.press('Back', 'app-onboarding .actions button');
    await u.waitText('app-onboarding', 'Choose your AI');
    await u.press('Groq Cloud AI', 'app-onboarding .choice');
    await u.press('Continue', 'app-onboarding .actions button');
    await u.waitText('app-onboarding', 'Connect to Groq', 15_000);
    pass('nobody is forced to install Ollama: going back to Groq works');
    check((await u.settings()).ai.provider === 'groq', 'the provider follows the choice');
    await u.finishSetup();
  }),
);

if (ollamaOnThisPc) {
  console.log('Scenario: Ollama installed but not running');
  removeData(
    await scenario('Ollama not running', {}, async (u) => {
      await u.evaluate(closedOllama);
      await u.press('Get started', 'app-onboarding button');
      await u.waitText('app-onboarding', 'Choose your AI');
      await u.press('Ollama Local AI', 'app-onboarding .choice');
      await u.press('Continue', 'app-onboarding .actions button');
      await u.waitText('app-onboarding', 'Step 1 of 2: start Ollama', 15_000);
      pass('Ollama installed but not running is told apart from not installed');
      await u.shot('16-ollama-not-running');
      await u.finishSetup();
    }),
  );
}

await new Promise((r) => (groq.listening ? groqDown().then(r) : r()));
removeData(noOllamaFolder);
finish();
