// Bundles the Electron main process and preload script with esbuild.
// Bundling is required for the preload: sandboxed preloads cannot require()
// local files, so shared code must be inlined.
import { build } from 'esbuild';

await build({
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
  outdir: 'dist-electron',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});
