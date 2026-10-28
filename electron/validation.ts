import type { AiMode, AiRequest, ChatMessage, HistoryKind, SttStartRequest } from '../shared/ipc';
import type { AudioSource, PositionPreset } from '../shared/settings';
import { SESSION_ID } from './history-store';

/**
 * Validators for every payload the renderer can send. The renderer is treated
 * as untrusted: anything malformed is rejected before it reaches a service.
 */

const MAX_INPUT = 12_000;
const MAX_CONTEXT = 8_000;
const MAX_MESSAGES = 24;
const AI_MODES: AiMode[] = ['answer', 'explain', 'chat', 'evaluate', 'generate-questions'];
const KINDS: HistoryKind[] = ['live', 'chat', 'practice'];
const SOURCES: AudioSource[] = ['mic', 'system'];
const PRESETS: PositionPreset[] = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'center'];

export class ValidationError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function optString(v: unknown, max: number, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ValidationError(`${field} must be a string`);
  return v.slice(0, max);
}

export function validateAiRequest(v: unknown): AiRequest {
  if (!isObj(v)) throw new ValidationError('Request must be an object');
  if (!AI_MODES.includes(v['mode'] as AiMode)) throw new ValidationError('Unknown mode');
  const mode = v['mode'] as AiMode;
  const input = optString(v['input'], MAX_INPUT, 'input') ?? '';
  if (!input.trim() && mode !== 'evaluate' && mode !== 'generate-questions') {
    throw new ValidationError('Enter a question or select transcript text first');
  }

  let messages: ChatMessage[] | undefined;
  if (Array.isArray(v['messages'])) {
    messages = v['messages']
      .slice(-MAX_MESSAGES)
      .filter((m): m is Obj => isObj(m) && (m['role'] === 'user' || m['role'] === 'assistant'))
      .map((m) => ({ role: m['role'] as ChatMessage['role'], content: optString(m['content'], MAX_INPUT, 'content') ?? '' }));
  }

  const length = v['length'];
  const sessionId = optString(v['sessionId'], 64, 'sessionId');
  return {
    mode,
    input,
    context: optString(v['context'], MAX_CONTEXT, 'context'),
    question: optString(v['question'], 2000, 'question'),
    messages,
    length: length === 'short' || length === 'medium' || length === 'detailed' ? length : undefined,
    sessionId: sessionId && SESSION_ID.test(sessionId) ? sessionId : undefined,
    kind: KINDS.includes(v['kind'] as HistoryKind) ? (v['kind'] as HistoryKind) : undefined,
  };
}

export function validateSttStart(v: unknown): SttStartRequest {
  if (!isObj(v)) throw new ValidationError('Request must be an object');
  const sessionId = v['sessionId'];
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new ValidationError('Invalid session id');
  const sources = Array.isArray(v['sources']) ? [...new Set(v['sources'])].filter((s): s is AudioSource => SOURCES.includes(s as AudioSource)) : [];
  if (sources.length === 0) throw new ValidationError('Select at least one audio source');
  return { sessionId, sources };
}

export function validateSource(v: unknown): AudioSource | null {
  return SOURCES.includes(v as AudioSource) ? (v as AudioSource) : null;
}

/** PCM arrives as an ArrayBuffer of 16-bit samples; cap chunk size at ~2 s. */
export function validatePcm(v: unknown): Int16Array | null {
  if (!(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v)) return null;
  const buf = v instanceof ArrayBuffer ? v : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  if (buf.byteLength === 0 || buf.byteLength % 2 !== 0 || buf.byteLength > 64_000) return null;
  return new Int16Array(buf);
}

export function validatePreset(v: unknown): PositionPreset | null {
  return PRESETS.includes(v as PositionPreset) ? (v as PositionPreset) : null;
}

/** API keys are opaque tokens; an empty string means "remove the key". */
export function validateApiKey(v: unknown): string {
  if (typeof v !== 'string') throw new ValidationError('API key must be a string');
  const key = v.trim();
  if (key && !/^[A-Za-z0-9_\-.]{20,200}$/.test(key)) {
    throw new ValidationError('That does not look like an API key. Copy the whole key from console.groq.com.');
  }
  return key;
}

export function validateId(v: unknown): string | null {
  return typeof v === 'string' && SESSION_ID.test(v) ? v : null;
}
