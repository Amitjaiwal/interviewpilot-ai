// End-to-end check of "Hide from screen sharing and recordings" on Windows.
//
//   npm run build && npm run test:protection
//
// Launches the built app with a throwaway data folder and reads the overlay's
// real display affinity with GetWindowDisplayAffinity: at startup, after
// toggling the setting, and after the window is hidden and shown again.
// WDA_EXCLUDEFROMCAPTURE means Windows excludes the window from capture APIs
// that honour display affinity; it does not prove every screen-sharing app does.
import { execFileSync, spawn } from 'node:child_process';
import electronPath from 'electron';
import { connect, launch, reporter, sleep, waitFor } from './harness.mjs';

const WDA_NONE = 0;
const WDA_EXCLUDEFROMCAPTURE = 0x11;
const TITLE = 'InterviewPilot AI';

const { pass, fail, skip, finish } = reporter();
if (process.platform !== 'win32') {
  skip('content protection', 'display affinity is Windows-only');
  finish();
}

/** Display affinity and visibility of the app's top-level window; affinity is -1 if it was not found. */
function readWindow(pid) {
  const script = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Wda {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Read(uint target, string title) {
    string result = "-1,0";
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var text = new StringBuilder(256); GetWindowText(h, text, 256);
      uint a;
      if (pid == target && text.ToString() == title && GetWindowDisplayAffinity(h, out a)) {
        result = a + "," + (IsWindowVisible(h) ? 1 : 0);
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
[Wda]::Read(${Number(pid)}, '${TITLE}')`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
  });
  if (!/^-?\d+,[01]$/.test(out.trim())) throw new Error(`Unexpected window probe output: ${out}`);
  const [affinity, visible] = out.trim().split(',').map(Number);
  if (affinity < 0) throw new Error(`No "${TITLE}" window found for pid ${pid}`);
  return { affinity, visible: visible === 1 };
}

const name = (a) => (a === WDA_EXCLUDEFROMCAPTURE ? 'WDA_EXCLUDEFROMCAPTURE' : a === WDA_NONE ? 'WDA_NONE' : `0x${a.toString(16)}`);

function check(label, expected) {
  const actual = readWindow(app.pid).affinity;
  if (actual === expected) pass(label, name(actual));
  else fail(label, `expected ${name(expected)}, got ${name(actual)}`);
}

const app = launch();
let cdp;
try {
  cdp = await connect(app.port);
  const { evaluate } = cdp;
  await waitFor(() => evaluate(`!!document.querySelector('.footer kbd')`), 20_000, 'UI to render');
  await sleep(500);

  const saved = await evaluate(`window.interviewPilot.settings.get().then(s => s.overlay.contentProtection)`);
  if (saved === true) pass('default preference', 'contentProtection=true');
  else fail('default preference', `contentProtection=${saved}`);
  check('startup applies the saved preference', WDA_EXCLUDEFROMCAPTURE);

  // The Settings checkbox goes through settings.update.
  await evaluate(`window.interviewPilot.settings.update({ overlay: { contentProtection: false } })`);
  check('turning the setting off', WDA_NONE);
  await evaluate(`window.interviewPilot.settings.update({ overlay: { contentProtection: true } })`);
  check('turning the setting on', WDA_EXCLUDEFROMCAPTURE);

  // Hide, then show again by launching a second instance (its handler calls show()).
  await evaluate(`window.interviewPilot.window.hide()`);
  await waitFor(async () => !readWindow(app.pid).visible, 5_000, 'window to hide');
  const env = { ...process.env, INTERVIEWPILOT_USER_DATA: app.userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_START_URL;
  await new Promise((resolve) => spawn(electronPath, ['.'], { env, stdio: 'ignore' }).on('exit', resolve));
  await waitFor(async () => readWindow(app.pid).visible, 10_000, 'window to be shown again');
  check('protection survives hide and show', WDA_EXCLUDEFROMCAPTURE);
} catch (err) {
  fail('content protection run', err instanceof Error ? err.message : String(err));
} finally {
  cdp?.close();
  await app.close();
}
finish();
