import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain CommonJS build script without type declarations
import { assertNoApiKey } from '../../scripts/no-secrets.cjs';

const SOURCE_ROOTS = ['electron', 'shared', 'src', 'scripts', 'tests', 'public', '.github'];
const SOURCE_FILES = ['README.md', 'package.json', 'angular.json'];
const TEXT = /\.(ts|mts|mjs|cjs|js|html|scss|css|json|md|ya?ml)$/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return TEXT.test(name) ? [full] : [];
  });
}

describe('API keys', () => {
  it('are not in the source code', () => {
    const files = [...SOURCE_ROOTS.flatMap(sourceFiles), ...SOURCE_FILES];
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) expect(() => assertNoApiKey(file), file).not.toThrow();
  });

  it('the check really finds one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ip-secrets-'));
    try {
      const file = path.join(dir, 'app.asar');
      // Assembled at runtime, so this test file does not itself look like it holds a key.
      const shaped = 'gsk_' + 'aB3'.repeat(17);
      writeFileSync(file, `some bundled code const key = "${shaped}"; more code`);
      expect(() => assertNoApiKey(file)).toThrow(/looks like a Groq API key/);
      // The failure message itself must not repeat the key, or it would end up in build logs.
      expect(() => assertNoApiKey(file)).not.toThrow(new RegExp(shaped));
      expect(readFileSync(file, 'utf8')).toContain(shaped);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the placeholder shown in the UI does not trip the check', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ip-secrets-'));
    try {
      const file = path.join(dir, 'app.asar');
      writeFileSync(file, 'placeholder="gsk_…" gsk_test_key_0123456789abcdef');
      expect(() => assertNoApiKey(file)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
