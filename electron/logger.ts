import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import * as path from 'node:path';

const MAX_BYTES = 1_000_000;

/**
 * Minimal file logger for troubleshooting. It records events and errors only;
 * transcripts, prompts and AI responses are never passed to it.
 */
export class Logger {
  constructor(private readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  get path(): string {
    return this.file;
  }

  info(scope: string, message: string): void {
    this.write('INFO', scope, message);
  }

  warn(scope: string, message: string): void {
    this.write('WARN', scope, message);
  }

  error(scope: string, message: string, err?: unknown): void {
    const detail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : '';
    this.write('ERROR', scope, message + detail);
  }

  private write(level: string, scope: string, message: string): void {
    const line = `${new Date().toISOString()} ${level} [${scope}] ${message}\n`;
    if (level !== 'INFO') console.warn(line.trimEnd());
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) {
        renameSync(this.file, `${this.file}.1`);
      }
      appendFileSync(this.file, line);
    } catch {
      // Logging must never crash the app.
    }
  }
}
