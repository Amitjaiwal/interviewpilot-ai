// electron-builder afterPack hook. Completes and checks the bundled whisper.cpp (see
// whisper-bundle.cjs), failing the build if it could not run on a clean PC or if an API
// key got into the package (no-secrets.cjs), then hardens the packaged InterviewPilot
// AI.exe with Electron fuses. Only the installed app is affected; `npm start`, `npm run
// dev` and the e2e tests use the unmodified Electron from node_modules.
//
// - RunAsNode off: ELECTRON_RUN_AS_NODE (often set by VS Code terminals) can no
//   longer turn the app into a bare Node runtime that never opens a window.
// - NODE_OPTIONS and --inspect are ignored, so no code can be injected or a
//   debugger attached through the shipped exe.
// - Only app.asar is loaded, never a loose resources/app folder.
// CommonJS because electron-builder 25 loads hooks with require().
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const { assertNoApiKey } = require('./no-secrets.cjs');
const { prepareWhisperBundle } = require('./whisper-bundle.cjs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  prepareWhisperBundle(path.join(context.appOutDir, 'resources', 'whisper'));
  console.log('  • whisper.cpp bundle complete, C++ runtime included');
  assertNoApiKey(path.join(context.appOutDir, 'resources', 'app.asar'));
  console.log('  • no API keys in the package');
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  console.log(`  • electron fuses applied  file=${path.basename(exe)}`);
};
