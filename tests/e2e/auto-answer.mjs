// Automatic answers in the real app: real settings file, real speech recognition from a fake
// microphone, and fake AI servers that count what reaches them.
//
//   npm run build && npm run test:auto-answer
//
// Requires whisper.cpp (npm run setup:whisper). Uses Groq's test URL, which the installed app
// ignores on purpose, so this runs against the project build only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { click, connect, launch, reporter, sleep, waitFor } from './harness.mjs';

const SPEECH_WAV = resolve(process.argv[2] ?? 'tests/fixtures/question-16k.wav');
const AI_PORT = 11596;
const AI_URL = `http://127.0.0.1:${AI_PORT}`;
// Obviously not a real key, and not shaped like one to the no-secrets check.
const FAKE_KEY = 'gsk_fake_key_for_tests_only_good';
/** Longer than the pause after which a line that is not a question gets answered (2.5 s). */
const LONGER_THAN_A_TURN_MS = 4000;

const { pass, fail, finish } = reporter();
const check = (ok, name, detail = '') => (ok ? pass(name) : fail(name, detail || 'check failed'));

// --------------------------------------------------------- fake Groq and Ollama
/** The latest user message of each answer request that reached the fake servers. */
let groqAsked = [];
let ollamaAsked = [];
const readBody = (req) =>
  new Promise((r) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => r(JSON.parse(body)));
  });
const lastUserMessage = (body) => body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';

const ai = createServer(async (req, res) => {
  const json = (body) => res.end(JSON.stringify(body));
  if (req.url === '/models') return json({ data: [{ id: 'openai/gpt-oss-120b', active: true }] });
  if (req.url === '/chat/completions') {
    groqAsked.push(lastUserMessage(await readBody(req)));
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Answer from fake Groq' } }] })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  if (req.url === '/api/version') return json({ version: '0.0-fake' });
  if (req.url === '/api/tags') return json({ models: [{ name: 'fake-model:1b', size: 1 }] });
  if (req.url === '/api/chat') {
    const body = await readBody(req);
    // An empty chat only loads the model before a session; it is not an answer.
    if (body.messages.length > 0) ollamaAsked.push(lastUserMessage(body));
    res.write(JSON.stringify({ message: { content: 'Answer from fake Ollama' }, done: false }) + '\n');
    return res.end(JSON.stringify({ done: true }) + '\n');
  }
  res.statusCode = 404;
  res.end();
});

// -------------------------------------------------------------------- helpers
let nextPort = 9350;
const folders = [];

/** Run one scenario against its own app instance, on the given data folder. */
async function scenario(name, userData, body) {
  console.log(`Scenario: ${name}`);
  const app = launch(['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${SPEECH_WAV}`], nextPort++, {
    userData,
    keepData: true,
    env: { INTERVIEWPILOT_GROQ_URL: AI_URL },
  });
  let cdp;
  try {
    cdp = await connect(app.port);
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.footer kbd')`), 30_000, 'the app to render');
    await body(ui(cdp, userData));
    // Quit normally. Chromium writes the key that protects secrets.json to disk within seconds
    // or on quit, and the next scenario needs it.
    await Promise.race([cdp.evaluate(`window.interviewPilot.window.close()`), sleep(1000)]).catch(() => undefined);
    await sleep(2500);
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  } finally {
    cdp?.close();
    await app.close();
  }
}

function ui(cdp, userData) {
  const { evaluate } = cdp;
  const checkbox = `[...document.querySelectorAll('app-settings label.toggle')].find((l) => l.textContent.includes('Answer automatically')).querySelector('input')`;
  return {
    evaluate,
    /** What is saved on disk: the setting as the next start will read it. */
    saved: () => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).ai.autoAnswer,
    /** The tick in Settings › AI model, as a user sees it. */
    ticked: async () => {
      await evaluate(click('.tabs button', 'Settings'));
      await waitFor(() => evaluate(`!!document.querySelector('app-settings:not([hidden]) label.toggle')`), 5000, 'the Settings tab');
      await sleep(200); // ngModel writes the value to the input after the first render
      return evaluate(`${checkbox}.checked`);
    },
    toggle: () => evaluate(`${checkbox}.click()`),
    /** Press Start and wait until whisper.cpp produces a new final line from the fake microphone. */
    listen: async () => {
      await evaluate(click('.tabs button', 'Live'));
      // Counted from here on: lines from an earlier capture stay on screen.
      await evaluate(`if (!window.__heard) window.interviewPilot.stt.onEvent((e) => { if (e.type === 'final' && e.text) window.__heard.push(e.text); }); window.__heard = []; true`);
      if (!(await evaluate(click('app-live button', 'Start')))) throw new Error('No Start button');
      const lines = await waitFor(() => evaluate(`window.__heard.length ? window.__heard : null`), 90_000, 'a transcribed line');
      return lines.join(' | ');
    },
    stop: async () => {
      await evaluate(click('app-live button', 'Stop'));
      await waitFor(() => evaluate(`!document.querySelector('.rec')`), 5000, 'capture to stop');
    },
    answerShown: (text) => waitFor(() => evaluate(`(document.querySelector('app-live app-response-view .md')?.textContent ?? '').includes(${JSON.stringify(text)})`), 15_000, `"${text}" in the response panel`),
    press: async (label) => {
      if (!(await evaluate(click('button', label)))) throw new Error(`No visible "${label}"`);
    },
  };
}

const newFolder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ip-auto-answer-'));
  folders.push(dir);
  return dir;
};

// ----------------------------------------------------------------- scenarios
await new Promise((r) => ai.listen(AI_PORT, '127.0.0.1', r));

try {
  // A new install: an empty data folder, on Groq.
  const install = newFolder();

  await scenario('first launch of a new install', install, async (u) => {
    await u.press('Skip setup');
    await waitFor(() => u.evaluate(`!!document.querySelector('.tabs')`), 5000, 'the main view');
    check((await u.saved()) === true, 'saved ON at first launch');
    check((await u.ticked()) === true, 'the checkbox is ticked the first time Settings opens');

    await u.evaluate(`window.interviewPilot.ai.setApiKey(${JSON.stringify(FAKE_KEY)})`);
    await u.evaluate(`window.interviewPilot.settings.update({ privacy: { captureConsent: true } })`);
    groqAsked = [];
    const heard = await u.listen();
    await waitFor(async () => groqAsked.length > 0, 20_000, 'an automatic request to Groq');
    await u.answerShown('Answer from fake Groq');
    pass('Groq answers speech without a click', `heard "${heard.slice(0, 80)}"`);
    await u.stop();
  });

  await scenario('restart with the setting on', install, async (u) => {
    check((await u.saved()) === true, 'still saved ON after a restart');
    check((await u.ticked()) === true, 'the checkbox is still ticked after a restart');
    groqAsked = [];
    await u.listen();
    await waitFor(async () => groqAsked.length > 0, 20_000, 'an automatic request to Groq');
    pass('still answers without a click after a restart');
    await u.stop();

    await u.ticked();
    await u.toggle();
    await waitFor(async () => (await u.saved()) === false, 3000, 'the choice to be saved');
    pass('unticking saves OFF');
    check((await u.ticked()) === false, 'the checkbox shows unticked');

    groqAsked = [];
    const heard = await u.listen();
    pass('unticked: live transcription keeps working', `heard "${heard.slice(0, 80)}"`);
    await sleep(LONGER_THAN_A_TURN_MS);
    check(groqAsked.length === 0, 'unticked: speech gets no automatic answer', JSON.stringify(groqAsked));
    await u.stop();

    await u.press('Suggest answer');
    await waitFor(async () => groqAsked.length === 1, 10_000, 'the manual request');
    await u.answerShown('Answer from fake Groq');
    pass('unticked: Suggest answer still works');
  });

  await scenario('restart with the setting off', install, async (u) => {
    check((await u.saved()) === false, 'still saved OFF after a restart');
    check((await u.ticked()) === false, 'the checkbox is still unticked after a restart');
    groqAsked = [];
    await u.listen();
    await sleep(LONGER_THAN_A_TURN_MS);
    check(groqAsked.length === 0, 'after a restart: speech still gets no automatic answer', JSON.stringify(groqAsked));
    await u.stop();

    await u.evaluate(`window.interviewPilot.settings.update({ ai: { responseLength: 'short' } })`);
    check((await u.saved()) === false, 'changing another setting leaves it OFF');

    await u.ticked();
    await u.toggle();
    await waitFor(async () => (await u.saved()) === true, 3000, 'the choice to be saved');
    pass('ticking it again saves ON');
  });

  // An upgrade from a version whose settings file has no saved choice, on local AI.
  const upgrade = newFolder();
  writeFileSync(
    join(upgrade, 'settings.json'),
    JSON.stringify({
      ai: { provider: 'local', answerEveryLine: false },
      ollama: { endpoint: AI_URL, model: '' },
      privacy: { captureConsent: true },
    }),
  );
  await scenario('existing install with nothing saved for this setting', upgrade, async (u) => {
    check((await u.ticked()) === true, 'upgrade with nothing saved: the checkbox is ticked');
    ollamaAsked = [];
    const heard = await u.listen();
    await waitFor(async () => ollamaAsked.length > 0, 20_000, 'an automatic request to Ollama');
    await u.answerShown('Answer from fake Ollama');
    pass('Ollama answers a detected question without a click', `heard "${heard.slice(0, 80)}"`);
    await u.stop();
  });

  // An upgrade from a version that saved the old default. It reads the same as a choice, so it is kept.
  const savedOff = newFolder();
  writeFileSync(join(savedOff, 'settings.json'), JSON.stringify({ ai: { provider: 'local', autoAnswer: false }, setup: { onboardingDone: true } }));
  await scenario('existing install with OFF saved', savedOff, async (u) => {
    check((await u.ticked()) === false, 'upgrade with OFF saved: the checkbox stays unticked');
  });
} catch (err) {
  fail('auto-answer walkthrough', err instanceof Error ? err.message : String(err));
} finally {
  ai.closeAllConnections();
  ai.close();
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
  finish();
}
