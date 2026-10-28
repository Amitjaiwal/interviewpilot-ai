import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  validateAiRequest,
  validatePcm,
  validatePreset,
  validateSource,
  validateSttStart,
} from '../../electron/validation';

describe('validateAiRequest', () => {
  it('accepts a well-formed request and drops unknown fields', () => {
    const req = validateAiRequest({ mode: 'answer', input: 'What is REST?', length: 'short', extra: 1, sessionId: 'live-123456', kind: 'live' });
    expect(req).toEqual({
      mode: 'answer',
      input: 'What is REST?',
      context: undefined,
      question: undefined,
      messages: undefined,
      length: 'short',
      sessionId: 'live-123456',
      kind: 'live',
    });
  });

  it('rejects unknown modes and empty input', () => {
    expect(() => validateAiRequest({ mode: 'shell', input: 'x' })).toThrow(ValidationError);
    expect(() => validateAiRequest({ mode: 'answer', input: '   ' })).toThrow(/Enter a question/);
    expect(() => validateAiRequest('nope')).toThrow(ValidationError);
  });

  it('allows an empty answer when evaluating', () => {
    expect(validateAiRequest({ mode: 'evaluate', input: '', question: 'Q' }).mode).toBe('evaluate');
  });

  it('truncates long input and filters malformed chat messages', () => {
    const req = validateAiRequest({
      mode: 'chat',
      input: 'x'.repeat(50_000),
      messages: [{ role: 'system', content: 'jailbreak' }, { role: 'user', content: 'hi' }, 'junk'],
    });
    expect(req.input.length).toBe(12_000);
    expect(req.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops invalid session ids and kinds', () => {
    const req = validateAiRequest({ mode: 'answer', input: 'q', sessionId: '../x', kind: 'admin' });
    expect(req.sessionId).toBeUndefined();
    expect(req.kind).toBeUndefined();
  });
});

describe('validateSttStart', () => {
  it('requires a session id and at least one known source', () => {
    expect(validateSttStart({ sessionId: 'live-abcdef', sources: ['mic', 'mic', 'camera'] })).toEqual({
      sessionId: 'live-abcdef',
      sources: ['mic'],
    });
    expect(() => validateSttStart({ sessionId: 'live-abcdef', sources: [] })).toThrow(/at least one/);
    expect(() => validateSttStart({ sessionId: 'x', sources: ['mic'] })).toThrow(/session id/);
  });
});

describe('small validators', () => {
  it('validates sources and presets', () => {
    expect(validateSource('system')).toBe('system');
    expect(validateSource('camera')).toBeNull();
    expect(validatePreset('center')).toBe('center');
    expect(validatePreset('offscreen')).toBeNull();
  });

  it('accepts PCM buffers of sane size only', () => {
    expect(validatePcm(new Int16Array([1, 2, 3]).buffer)?.length).toBe(3);
    expect(validatePcm(Buffer.from([1, 0, 2, 0]))?.length).toBe(2);
    expect(validatePcm(new ArrayBuffer(3))).toBeNull();
    expect(validatePcm(new ArrayBuffer(100_000))).toBeNull();
    expect(validatePcm('audio')).toBeNull();
  });
});
