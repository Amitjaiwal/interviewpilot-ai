import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain CommonJS build script without type declarations
import { findLoadProblems, prepareWhisperBundle } from '../../scripts/whisper-bundle.cjs';

/** Runs on the real whisper.cpp release files from `npm run setup:whisper`; skipped when they are missing. */
const releaseBin = path.resolve('tools', 'whisper', 'bin');
const available = existsSync(path.join(releaseBin, 'whisper-server.exe'));

const RUNTIME = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll'];
const MODELS = ['ggml-small.en.bin', 'ggml-base.en.bin', 'ggml-silero-v5.1.2.bin'];

describe.skipIf(!available)('whisper bundle for the installer', () => {
  let dir: string;
  let bin: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ip-bundle-'));
    bin = path.join(dir, 'bin');
    mkdirSync(bin);
    mkdirSync(path.join(dir, 'models'));
    // The same selection as extraResources in package.json.
    for (const f of readdirSync(releaseBin).filter((n) => /^(whisper-server\.exe|whisper\.dll|ggml.*\.dll)$/i.test(n))) {
      copyFileSync(path.join(releaseBin, f), path.join(bin, f));
    }
    for (const m of MODELS) writeFileSync(path.join(dir, 'models', m), '');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('detects that the release files alone would not start on a clean PC', () => {
    const needed = new Set(findLoadProblems(bin).map((p: string) => p.split(' needs ')[1].toLowerCase()));
    expect([...needed].sort()).toEqual([...RUNTIME].sort());
  });

  it('adds the C++ runtime, which leaves nothing unresolved', () => {
    prepareWhisperBundle(dir);
    for (const dll of RUNTIME) expect(existsSync(path.join(bin, dll))).toBe(true);
    expect(findLoadProblems(bin)).toEqual([]);
  });

  it('refuses a bundle without a speech model, which electron-builder would skip silently', () => {
    rmSync(path.join(dir, 'models', 'ggml-small.en.bin'));
    expect(() => prepareWhisperBundle(dir)).toThrow(/ggml-small\.en\.bin.*setup:whisper:installer/);
  });

  it('refuses a binary that needs a DLL nobody ships', () => {
    prepareWhisperBundle(dir);
    rmSync(path.join(bin, 'whisper.dll'));
    expect(findLoadProblems(bin)).toContain('whisper-server.exe needs whisper.dll');
  });
});
