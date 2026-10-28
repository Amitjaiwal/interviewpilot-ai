import { safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Holds the Groq API key, encrypted with the OS credential protection (DPAPI
 * on Windows) via Electron's safeStorage. Kept out of settings.json so the key
 * is never sent to the renderer, copied into diagnostics or stored in plain text.
 */
export class SecretStore {
  private cached: string | null = null;

  constructor(private readonly file: string) {}

  get groqApiKey(): string {
    if (this.cached === null) this.cached = this.read();
    return this.cached;
  }

  setGroqApiKey(key: string): void {
    if (!key) {
      rmSync(this.file, { force: true });
      this.cached = '';
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system, so the API key cannot be saved.');
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ groqApiKey: safeStorage.encryptString(key).toString('base64') }));
    renameSync(tmp, this.file);
    this.cached = key;
  }

  private read(): string {
    try {
      const { groqApiKey } = JSON.parse(readFileSync(this.file, 'utf8')) as { groqApiKey?: string };
      return groqApiKey ? safeStorage.decryptString(Buffer.from(groqApiKey, 'base64')) : '';
    } catch {
      return '';
    }
  }
}
