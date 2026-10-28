// Real Windows loopback test (no fake devices).
//
//   npm run build && npm run test:loopback
//
// Starts "System audio" capture in the app, then plays a speech WAV through
// the default output device with Windows' SoundPlayer. The app should hear it
// via WASAPI loopback and transcribe it as "Meeting" speech.
// This plays ~5 seconds of audible speech, and needs a working output device
// (muting the speakers does not matter; loopback captures the digital mix).
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { click, connect, launch, reporter, sleep, waitFor } from './harness.mjs';

const WAV = resolve(process.argv[2] ?? 'tests/fixtures/question-16k.wav');
const app = launch([], 9334);
const { pass, fail, finish } = reporter();

function play(file) {
  return new Promise((r) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`], {
      stdio: 'ignore',
      windowsHide: true,
    });
    ps.on('exit', r);
  });
}

try {
  const { evaluate, close } = await connect(app.port);
  await waitFor(() => evaluate(`!!document.querySelector('.footer kbd')`), 20_000, 'UI to render');
  await evaluate(`window.interviewPilot.settings.update({ privacy: { captureConsent: true }, stt: { sources: { mic: false, system: true } } })`);
  await evaluate(click('app-live button', 'Start'));
  await waitFor(() => evaluate(`document.querySelector('app-live')?.textContent.includes('Listening')`), 30_000, 'speech engine ready');
  const err = await evaluate(`document.querySelector('app-live .error-box')?.textContent?.trim() ?? null`);
  if (err) throw new Error(err);
  pass('loopback capture started');

  await sleep(500);
  await play(WAV);
  const text = await waitFor(
    () =>
      evaluate(`(() => { const t = [...document.querySelectorAll('app-live .seg:not(.partial)')]
        .filter(s => s.textContent.includes('Meeting') || s.querySelector('.who.sys')).map(s => s.querySelector('.text').textContent.trim()).join(' ');
        return t.length > 10 ? t : null; })()`),
    30_000,
    'loopback transcript',
  );
  pass('real system audio transcribed', `"${text}"`);
  await evaluate(click('app-live button', 'Stop'));
  close();
} catch (e) {
  fail('loopback', e instanceof Error ? e.message : String(e));
} finally {
  await app.close();
  finish();
}
