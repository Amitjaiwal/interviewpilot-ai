import { toAccelerator } from '../settings/settings.component';
import { QUESTION_BANK, parseQuestionList, parseScore, sampleQuestions } from './question-bank';

describe('question bank', () => {
  it('has Java and full-stack categories with unique ids', () => {
    const ids = QUESTION_BANK.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('core-java');
    expect(ids).toContain('spring');
    expect(ids).toContain('angular');
    expect(QUESTION_BANK.every((c) => c.questions.length >= 5)).toBeTrue();
  });

  it('samples without repeats and filters by level', () => {
    const cat = QUESTION_BANK[0];
    const all = sampleQuestions(cat, 100);
    expect(new Set(all).size).toBe(cat.questions.length);
    const basic = sampleQuestions(cat, 100, 'basic');
    expect(basic.length).toBe(cat.questions.filter((q) => q.level === 'basic').length);
  });

  it('parses numbered and bulleted question lists from model output', () => {
    const text = 'Here are questions:\n1. How did you scale the payments API?\n2) What is **idempotency**?\n- Explain Kafka consumer groups\n3. ok';
    expect(parseQuestionList(text)).toEqual([
      'How did you scale the payments API?',
      'What is idempotency?',
      'Explain Kafka consumer groups',
    ]);
  });

  it('reads scores from evaluations', () => {
    expect(parseScore('**Score:** 7/10\n**Strengths:**')).toBe(7);
    expect(parseScore('Score: 8.5 / 10')).toBe(8.5);
    expect(parseScore('No score here')).toBeNull();
    expect(parseScore('Score: 42/10')).toBeNull();
  });
});

describe('toAccelerator', () => {
  const key = (k: Partial<KeyboardEvent>) =>
    toAccelerator({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...k });

  it('builds accelerators from modifier combinations', () => {
    expect(key({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true })).toBe('CommandOrControl+Shift+K');
    expect(key({ key: ' ', code: 'Space', ctrlKey: true, altKey: true })).toBe('CommandOrControl+Alt+Space');
    expect(key({ key: '1', code: 'Digit1', altKey: true })).toBe('Alt+1');
  });

  it('allows bare function keys but not bare letters or lone modifiers', () => {
    expect(key({ key: 'F9', code: 'F9' })).toBe('F9');
    expect(key({ key: 'a', code: 'KeyA' })).toBeNull();
    expect(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })).toBeNull();
  });
});
