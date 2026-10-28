import type { AiRequest } from '../shared/ipc';
import type { ResponseLength, Settings } from '../shared/settings';
import type { OllamaChatOptions, OllamaMessage } from './ollama-client';

const LENGTH_GUIDE: Record<ResponseLength, { text: string; numPredict: number }> = {
  short: { text: 'Be brief: 2-4 sentences or at most 5 bullet points. No preamble.', numPredict: 300 },
  medium: {
    text: 'Aim for roughly 120-220 words: the key points, plus a short example or snippet if it helps.',
    numPredict: 700,
  },
  detailed: {
    text:
      'Be thorough: explain the concept, include a code example when relevant, give Big-O time and space ' +
      'for any algorithm you show, and cover trade-offs and common pitfalls.',
    numPredict: 1600,
  },
};

const FORMAT_RULES =
  'Format with Markdown. Put code in fenced blocks with a language tag. ' +
  'Prefer Java for code unless the question names another language.';

function speechNote(settings: Settings): string {
  const vocabulary = settings.stt.vocabulary.trim();
  return (
    'The text comes from speech recognition and may contain misheard technical terms ' +
    '(for example "in a return" or "in retention" for inheritance, "Javaite" for Java 8, "angler" for Angular, ' +
    '"spring boat" for Spring Boot, "our ex JS" for RxJS). If a phrase sounds like one of the terms ' +
    'below or makes little sense in a technical interview, read it as the most likely technical term ' +
    'and answer that directly. Never mention or discuss the mishearing. A short topic such as ' +
    '"Java 8 features" or "Internal working of HashMap" is a question: explain that topic.' +
    (vocabulary ? `\nTerms likely to come up: ${vocabulary}` : '')
  );
}

const MAX_RESUME_IN_PROMPT = 6000;
const MAX_CONTEXT_IN_PROMPT = 3000;

function persona(settings: Settings): string {
  const role = settings.profile.targetRole.trim();
  return (
    'You are InterviewPilot, a precise technical interview coach for software engineers' +
    (role ? `, currently helping a candidate preparing for a "${role}" role` : '') +
    '. Be accurate; if a question is ambiguous, state the assumption you make.'
  );
}

function profileBlock(settings: Settings): string {
  const resume = settings.profile.resumeText.trim();
  if (!resume) return '';
  return `\n\nCandidate resume (use it to personalise examples; never invent experience that is not in it):\n"""\n${resume.slice(0, MAX_RESUME_IN_PROMPT)}\n"""`;
}

function modeInstructions(req: AiRequest): string {
  switch (req.mode) {
    case 'answer':
      return (
        'The user heard the interview question below. Write the answer the candidate could give, in the ' +
        'first person and a natural spoken style. Lead with the direct answer, then supporting detail. ' +
        'If it is not phrased as a question (a follow-up, a remark, or part of a task given in plain sentences), ' +
        'use the transcript to work out what the interviewer wants and answer that. ' +
        'If it is a coding or algorithm question: state the approach, then the code, then its Big-O time and space complexity.'
      );
    case 'explain':
      return (
        'Explain the text below to someone studying for interviews: what it means, why it matters, and ' +
        'a concrete example. If it is a question, also outline how to answer it.'
      );
    case 'chat':
      return 'You are a patient study partner. Answer the user\'s questions and help them practise.';
    case 'evaluate':
      return (
        'Evaluate the candidate\'s answer to the interview question. Use exactly this structure:\n' +
        '**Score:** N/10\n**Strengths:** bullet list\n**Gaps or mistakes:** bullet list\n' +
        '**Improved answer:** a model answer in the first person.\nBe honest and specific.'
      );
    case 'generate-questions':
      return (
        'Write interview practice questions tailored to the candidate. Output only a numbered list of ' +
        'questions (one per line, no answers, no headings). Mix fundamentals, practical scenarios and ' +
        'questions about projects in the resume.'
      );
  }
}

/** Build the Ollama messages and options for a request. */
export function buildChat(req: AiRequest, settings: Settings): { messages: OllamaMessage[]; options: OllamaChatOptions } {
  const length = LENGTH_GUIDE[req.length ?? settings.ai.responseLength];
  const custom = settings.ai.customInstructions.trim();
  const usesProfile = req.mode !== 'explain';

  const system = [
    persona(settings),
    modeInstructions(req),
    req.mode === 'answer' || req.mode === 'explain' ? speechNote(settings) : '',
    req.mode === 'generate-questions' ? '' : `${length.text} ${FORMAT_RULES}`,
    custom ? `Additional instructions from the user: ${custom}` : '',
  ]
    .filter(Boolean)
    .join('\n\n') + (usesProfile ? profileBlock(settings) : '');

  const messages: OllamaMessage[] = [{ role: 'system', content: system }];
  const context = req.context?.trim();

  switch (req.mode) {
    case 'chat':
      for (const m of req.messages ?? []) messages.push({ role: m.role, content: m.content });
      messages.push({ role: 'user', content: req.input });
      break;
    case 'evaluate':
      messages.push({
        role: 'user',
        content: `Question:\n${req.question ?? ''}\n\nCandidate's answer:\n${req.input || '(no answer given)'}`,
      });
      break;
    case 'generate-questions':
      messages.push({
        role: 'user',
        content: `Topic: ${req.question || 'mixed'}\nNumber of questions: ${req.input || '5'}`,
      });
      break;
    default:
      messages.push({
        role: 'user',
        content:
          (context ? `Recent conversation transcript (for context):\n"""\n${context.slice(-MAX_CONTEXT_IN_PROMPT)}\n"""\n\n` : '') +
          `${req.mode === 'answer' ? 'Question' : 'Text'}:\n${req.input}`,
      });
  }

  return {
    messages,
    options: {
      temperature: settings.ollama.temperature,
      num_predict: req.mode === 'generate-questions' ? 600 : length.numPredict,
      num_ctx: 8192,
    },
  };
}
