// End-to-end smoke test of the built desktop app.
//
//   npm run build && npm run test:e2e [-- <speech.wav> <screenshot-folder>]
//
// Launches Electron with a throwaway data folder and Chromium's fake
// microphone fed from a speech WAV, then drives the real UI over the Chrome
// DevTools Protocol. Requires whisper.cpp (npm run setup:whisper); Ollama
// checks are skipped when Ollama is not running.
//
// Note: --use-fake-device-for-media-stream also replaces the loopback source,
// so the system-audio check here exercises the pipeline, not real Windows
// loopback. tests/e2e/loopback.mjs covers real loopback.
import { join, resolve } from 'node:path';
import { click, connect, launch, reporter, sleep, type, waitFor } from './harness.mjs';

const SPEECH_WAV = resolve(process.argv[2] ?? 'tests/fixtures/question-16k.wav');
/** Optional folder for screenshots of each view. */
const SHOTS = process.argv[3];

const app = launch(['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${SPEECH_WAV}`]);
const { pass, fail, skip, finish } = reporter();

const getUserMedia = `navigator.mediaDevices.getUserMedia({ audio: true })
  .then(s => { s.getTracks().forEach(t => t.stop()); return 'granted'; }, e => e.name)`;

/** Run an AI request through the preload API and resolve with its final event. */
const aiRequest = (req) => `new Promise((resolve) => {
  const events = [];
  const off = window.interviewPilot.ai.onEvent((e) => {
    events.push(e.type);
    if (e.type === 'done' || e.type === 'error') { off(); resolve({ events, final: e }); }
  });
  window.interviewPilot.ai.start(${JSON.stringify(req)});
})`;

let cdp;
async function screenshot(name) {
  if (!SHOTS) return;
  // Let the compositor produce a frame for the latest DOM before capturing.
  await sleep(400);
  await cdp.screenshot(join(SHOTS, `${name}.png`));
}

try {
  cdp = await connect(app.port);
  const { evaluate } = cdp;
  await waitFor(() => evaluate(`!!document.querySelector('.footer kbd')`), 20_000, 'UI to render');
  pass('app starts and renders');

  // ---------------------------------------------------------- security
  const sec = await evaluate(`({ require: typeof require, process: typeof process, api: typeof window.interviewPilot,
    ipc: typeof window.interviewPilot?.ipcRenderer, open: window.open('https://example.com') === null })`);
  if (sec.require === 'undefined' && sec.process === 'undefined' && sec.api === 'object' && sec.ipc === 'undefined' && sec.open) {
    pass('renderer isolation', 'no Node globals, only the preload API, popups blocked');
  } else fail('renderer isolation', JSON.stringify(sec));

  const invalid = await evaluate(`window.interviewPilot.ai.start({ mode: 'shell', input: 'x' }).then(() => 'accepted', e => e.message)`);
  if (/Unknown mode/.test(invalid)) pass('IPC validation rejects bad input');
  else fail('IPC validation rejects bad input', invalid);

  const micDenied = await evaluate(getUserMedia);
  if (micDenied === 'NotAllowedError') pass('microphone denied before consent and Start');
  else fail('microphone denied before consent and Start', micDenied);

  // ------------------------------------------------------------ settings
  const patched = await evaluate(`window.interviewPilot.settings.update({ overlay: { opacity: 0.85 }, ollama: { endpoint: 'file:///etc' } })`);
  if (patched.overlay.opacity === 0.85 && patched.ollama.endpoint === 'http://127.0.0.1:11434') {
    pass('settings update validated and persisted in main');
  } else fail('settings update', JSON.stringify(patched.ollama));

  // -------------------------------------------------------------- Ollama
  const status = await evaluate(`window.interviewPilot.ai.status()`);
  if (!status.reachable) {
    skip('Ollama streaming', status.error);
  } else {
    pass('Ollama status', `${status.version}, using ${status.activeModel}`);
    const stream = await evaluate(aiRequest({ mode: 'explain', input: 'In one sentence: what is a Java HashMap?', length: 'short' }));
    const chunks = stream.events.filter((t) => t === 'chunk').length;
    if (stream.final.type === 'done' && chunks >= 1 && stream.final.text.length > 10) {
      pass('Ollama streamed response', `${chunks} chunk messages, ${stream.final.durationMs} ms`);
    } else fail('Ollama streamed response', JSON.stringify(stream.final));

    await evaluate(`window.interviewPilot.settings.update({ ollama: { model: 'no-such-model:1b' } })`);
    const missing = (await evaluate(aiRequest({ mode: 'answer', input: 'hi' }))).final;
    await evaluate(`window.interviewPilot.settings.update({ ollama: { model: '' } })`);
    if (missing.code === 'model-missing') pass('missing model reported gracefully', missing.message);
    else fail('missing model reported gracefully', JSON.stringify(missing));
  }

  await evaluate(`window.interviewPilot.settings.update({ ollama: { endpoint: 'http://127.0.0.1:9' } })`);
  const unreachable = (await evaluate(aiRequest({ mode: 'answer', input: 'hi' }))).final;
  await evaluate(`window.interviewPilot.settings.update({ ollama: { endpoint: 'http://127.0.0.1:11434' } })`);
  if (unreachable.code === 'unreachable') pass('unavailable Ollama reported gracefully');
  else fail('unavailable Ollama reported gracefully', JSON.stringify(unreachable));

  // ------------------------------------------------- microphone capture
  await evaluate(`window.interviewPilot.settings.update({ stt: { sources: { mic: true, system: false } } })`);
  await evaluate(click('app-live button', 'Start'));
  await waitFor(() => evaluate(`!!document.querySelector('.modal')`), 5000, 'consent dialog');
  pass('capture consent dialog shown on first Start');
  await evaluate(click('.modal button', 'I understand'));

  await waitFor(() => evaluate(`document.querySelector('.rec')?.textContent.includes('REC')`), 10_000, 'REC indicator');
  pass('REC indicator visible while capturing');

  const transcript = await waitFor(
    () =>
      evaluate(`(() => { const t = [...document.querySelectorAll('app-live .seg:not(.partial) .text')].map(e => e.textContent.trim()).join(' | ');
        return t.length > 10 ? t : null; })()`),
    60_000,
    'a transcribed segment from the fake microphone',
  );
  pass('microphone transcription', `"${transcript.slice(0, 120)}"`);

  if (await evaluate(`!!document.querySelector('app-live .seg.question')`)) pass('question detection marks the segment');
  else skip('question detection', 'no segment flagged as a question yet (depends on audio timing)');

  await evaluate(click('app-live button', 'Pause'));
  await waitFor(() => evaluate(`document.querySelector('.rec')?.textContent.includes('PAUSED')`), 5000, 'paused state');
  await evaluate(click('app-live button', 'Resume'));
  await waitFor(() => evaluate(`document.querySelector('.rec')?.textContent.includes('REC')`), 5000, 'recording state');
  pass('pause and resume');
  await screenshot('live');

  await evaluate(click('app-live button', 'Stop'));
  await waitFor(() => evaluate(`!document.querySelector('.rec')`), 5000, 'capture to stop');
  pass('stop clears the REC indicator');

  const micAfterStop = await evaluate(getUserMedia);
  if (micAfterStop === 'NotAllowedError') pass('microphone denied again after Stop');
  else fail('microphone denied again after Stop', micAfterStop);

  // ---------------------------------------- system audio (fake source)
  await evaluate(`window.interviewPilot.settings.update({ stt: { sources: { mic: false, system: true } } })`);
  await evaluate(click('app-live button', 'Start'));
  await sleep(2500);
  const sys = await evaluate(`({ rec: !!document.querySelector('.rec'), err: document.querySelector('app-live .error-box')?.textContent?.trim() ?? null })`);
  if (sys.rec && !sys.err) pass('system audio capture pipeline (getDisplayMedia + permission gates)');
  else fail('system audio capture pipeline', sys.err ?? 'not recording');
  await evaluate(click('app-live button', 'Stop'));
  await waitFor(() => evaluate(`!document.querySelector('.rec')`), 5000, 'capture to stop');

  // ------------------------------------------------------- UI AI flows
  if (status.reachable) {
    // A real, long stream: the answer panel must stay at the top while text streams in,
    // keep the position the reader scrolls to, and the answer must still finish.
    await evaluate(click('app-live .segmented button', 'Detailed'));
    await evaluate(type('app-live textarea', 'Explain how HashMap works internally in Java, with a code example.'));
    await evaluate(click('app-live button', 'Suggest answer'));
    const scroll = await evaluate(`new Promise((resolve) => {
      const body = document.querySelector('app-live .answer .panel-body');
      const view = () => document.querySelector('app-live app-response-view');
      const length = () => view().querySelector('.md')?.textContent.length ?? 0;
      const r = { stayedAtTop: true, overflowed: false, keptReaderPosition: true, grewAfterScroll: false, finished: false, realInputs: 0 };
      // The overlay is always on top, so a real mouse wheel over it scrolls the panel (Windows
      // scrolls the window under the cursor). Moves right after real input are the reader's.
      let lastInput = -Infinity;
      const onInput = (e) => { if (e.isTrusted) { lastInput = performance.now(); r.realInputs++; } };
      const inputs = ['wheel', 'keydown', 'pointerdown', 'touchmove'];
      inputs.forEach((t) => window.addEventListener(t, onInput, { capture: true, passive: true }));
      const byReader = () => performance.now() - lastInput < 1000;
      let readerTop = null, lengthAtScroll = 0, samples = 0;
      const started = Date.now();
      const finish = () => {
        inputs.forEach((t) => window.removeEventListener(t, onInput, { capture: true }));
        resolve(r);
      };
      const tick = () => {
        samples++;
        if (readerTop === null) {
          if (body.scrollTop !== 0 && !byReader()) r.stayedAtTop = false;
          if (body.scrollHeight > body.clientHeight + 150) {
            r.overflowed = true;
            body.scrollTop = 80;
            readerTop = body.scrollTop;
            lengthAtScroll = length();
          }
        } else {
          if (Math.abs(body.scrollTop - readerTop) > 1) {
            if (byReader()) readerTop = body.scrollTop;
            else r.keptReaderPosition = false;
          }
          if (length() > lengthAtScroll) r.grewAfterScroll = true;
        }
        if (samples > 3 && !view().querySelector('.spinner')) {
          r.finished = /\\d\\.\\ds/.test(view().querySelector('.meta').textContent);
          return finish();
        }
        if (Date.now() - started > 180000) return finish();
        setTimeout(tick, 30);
      };
      tick();
    })`);
    if (!scroll.overflowed) skip('answer scroll position', 'the answer was too short to overflow the panel');
    else if (scroll.stayedAtTop && scroll.keptReaderPosition && scroll.grewAfterScroll && scroll.finished) {
      pass(
        'answer stays at the top while streaming and keeps the reader\'s scroll position',
        scroll.realInputs ? `${scroll.realInputs} real mouse/keyboard inputs during the check were followed` : '',
      );
    } else fail('answer scroll position', JSON.stringify(scroll));

    await evaluate(click('app-live .segmented button', 'Medium'));
    await evaluate(type('app-live textarea', 'What is the time complexity of HashMap get? Show a tiny Java example.'));
    await evaluate(click('app-live button', 'Suggest answer'));
    const answer = await waitFor(
      () => evaluate(`(() => { const md = document.querySelector('app-live app-response-view .md');
        const busy = document.querySelector('app-live app-response-view .spinner');
        return md && !busy && md.textContent.length > 40 ? md.innerHTML : null; })()`),
      120_000,
      'the streamed answer in the response panel',
    );
    pass('UI answer streamed and rendered', `${answer.includes('class="code"') ? 'with' : 'without'} a code block`);
    await screenshot('answer');

    await evaluate(click('.tabs button', 'Chat'));
    await evaluate(click('app-chat .starter', 'Spring Boot'));
    await waitFor(
      () => evaluate(`document.querySelectorAll('app-chat .msg.bot .md').length > 0 && !document.querySelector('app-chat .spinner')`),
      120_000,
      'chat answer',
    );
    pass('study chat round trip');
    await screenshot('chat');

    await evaluate(click('.tabs button', 'Practice'));
    await evaluate(type('app-practice textarea', 'Use equals for value comparison and == for reference identity.'));
    await evaluate(click('app-practice button', 'Evaluate'));
    const score = await waitFor(
      () => evaluate(`(() => { const t = document.querySelector('app-practice app-response-view .md')?.textContent ?? '';
        return !document.querySelector('app-practice .spinner') && /score/i.test(t) ? t.slice(0, 60) : null; })()`),
      120_000,
      'answer evaluation',
    );
    pass('practice answer evaluation', score.replace(/\s+/g, ' '));
    await screenshot('practice');
  }

  await evaluate(click('.tabs button', 'Settings'));
  await screenshot('settings');

  // ------------------------------------------------------ resume import
  for (const file of ['resume.pdf', 'resume.docx']) {
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const input = await cdp.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'app-settings input[type=file]' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: input.result.nodeId, files: [resolve('tests/fixtures', file)] });
    const imported = await waitFor(
      () => evaluate(`(() => { const t = [...document.querySelectorAll('app-settings .hint')].map(h => h.textContent).find(h => h.includes(${JSON.stringify(file)}));
        return t && !t.includes('Reading') ? t : null; })()`),
      20_000,
      `${file} import`,
    );
    const resume = (await evaluate(`window.interviewPilot.settings.get()`)).profile.resumeText;
    if (imported.startsWith('Imported') && /Spring Boot microservices/.test(resume)) pass(`resume import (${file})`, imported.trim());
    else fail(`resume import (${file})`, `${imported} | ${resume.slice(0, 80)}`);
  }

  // ------------------------------------------------------------ history
  await evaluate(click('.tabs button', 'History'));
  await sleep(1500); // history writes are batched for one second
  const history = await evaluate(`window.interviewPilot.history.list('')`);
  const live = history.find((h) => h.kind === 'live' && h.transcriptCount > 0);
  if (live) pass('session saved to history', `${live.transcriptCount} transcript lines, ${history.length} session(s)`);
  else fail('session saved to history', JSON.stringify(history));
  // Search for the longest word of the recognised speech, in upper case to check case-insensitivity.
  const term = (live?.title ?? '').split(/\W+/).sort((a, b) => b.length - a.length)[0]?.toUpperCase() ?? 'X';
  const searched = await evaluate(`window.interviewPilot.history.list(${JSON.stringify(term)})`);
  if (searched.some((h) => h.id === live?.id && h.snippet)) pass('history search', `"${term}" -> ${searched[0].snippet.slice(0, 60)}`);
  else fail('history search', `${term}: ${JSON.stringify(searched)}`);
  await screenshot('history');

  cdp.close();
} catch (err) {
  fail('e2e run', err instanceof Error ? err.message : String(err));
} finally {
  await app.close();
  finish();
}
