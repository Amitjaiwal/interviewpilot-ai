// Launches Electron for this project.
// VS Code terminals often export ELECTRON_RUN_AS_NODE=1, which makes Electron
// behave like plain Node and never open a window, so we strip it here.
// Pass --dev to load the Angular dev server instead of the built files.
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--dev')) {
  env.ELECTRON_START_URL = 'http://localhost:4200';
}

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env, windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));
