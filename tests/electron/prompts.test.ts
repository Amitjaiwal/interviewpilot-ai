import { describe, expect, it } from 'vitest';
import { buildChat } from '../../electron/prompts';
import { DEFAULT_SETTINGS, Settings, sanitizeSettings } from '../../shared/settings';

const withProfile: Settings = sanitizeSettings({
  profile: { targetRole: 'Java Backend Engineer', resumeText: 'Built Spring Boot payment services at Acme.' },
  ai: { customInstructions: 'Use British spelling.' },
});

describe('buildChat', () => {
  it('builds an answer prompt with context, role, resume and custom instructions', () => {
    const { messages, options } = buildChat(
      { mode: 'answer', input: 'What is a HashMap?', context: 'Interviewer: lets talk collections' },
      withProfile,
    );
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Java Backend Engineer');
    expect(messages[0].content).toContain('Spring Boot payment services');
    expect(messages[0].content).toContain('British spelling');
    expect(messages[1].content).toContain('lets talk collections');
    expect(messages[1].content).toContain('Question:\nWhat is a HashMap?');
    expect(options.num_predict).toBe(700);
  });

  it('applies the requested length over the default', () => {
    const short = buildChat({ mode: 'explain', input: 'q', length: 'short' }, DEFAULT_SETTINGS);
    const detailed = buildChat({ mode: 'explain', input: 'q', length: 'detailed' }, DEFAULT_SETTINGS);
    expect(short.messages[0].content).toContain('Be brief');
    expect(detailed.messages[0].content).toContain('Be thorough');
    expect(short.messages[0].content).not.toContain('Be thorough');
    expect(detailed.options.num_predict!).toBeGreaterThan(short.options.num_predict!);
  });

  it('does not add the resume to plain explanations', () => {
    const { messages } = buildChat({ mode: 'explain', input: 'CAP theorem' }, withProfile);
    expect(messages[0].content).not.toContain('Spring Boot payment services');
  });

  it('keeps chat history in order before the new message', () => {
    const { messages } = buildChat(
      {
        mode: 'chat',
        input: 'and in Java 21?',
        messages: [
          { role: 'user', content: 'what are virtual threads' },
          { role: 'assistant', content: 'Lightweight threads...' },
        ],
      },
      DEFAULT_SETTINGS,
    );
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[3].content).toBe('and in Java 21?');
  });

  it('asks for a structured score when evaluating', () => {
    const { messages } = buildChat({ mode: 'evaluate', question: 'What is ACID?', input: 'Atomicity...' }, DEFAULT_SETTINGS);
    expect(messages[0].content).toContain('**Score:** N/10');
    expect(messages[1].content).toContain('Question:\nWhat is ACID?');
    expect(messages[1].content).toContain('Atomicity...');
  });

  it('requests a numbered list for question generation', () => {
    const { messages } = buildChat({ mode: 'generate-questions', input: '7', question: 'Spring Boot' }, withProfile);
    expect(messages[0].content).toContain('numbered list');
    expect(messages[1].content).toContain('Topic: Spring Boot');
    expect(messages[1].content).toContain('Number of questions: 7');
  });
});
