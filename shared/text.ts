/**
 * Pure text helpers for transcripts. No Node or DOM APIs, so they run in the
 * main process, the renderer and unit tests alike.
 */

/** Non-speech annotations whisper emits, e.g. [BLANK_AUDIO], (music), *laughs*. */
const ANNOTATION = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g;

/**
 * Phrases whisper is known to hallucinate on silence or noise. They are only
 * dropped when they make up the entire segment.
 */
const HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thank you.',
  'thanks for watching',
  'thanks for watching!',
  'thank you for watching',
  'thank you for watching.',
  'bye',
  'bye.',
  'okay.',
  '.',
  'so',
]);

/** Remove annotations, whitespace noise and repetition loops from a whisper result. */
export function cleanTranscript(raw: string): string {
  const text = collapseRepeats(raw.replace(ANNOTATION, ' ').replace(/\s+/g, ' ').trim());
  if (!/[a-z0-9]/i.test(text)) return '';
  if (HALLUCINATIONS.has(text.toLowerCase())) return '';
  return text;
}

/** Prompts phrased as requests rather than questions. */
const REQUEST_VERB =
  'explain|describe|tell me|walk me through|talk about|give me|define|compare|implement|write|design|introduce|start with|begin with|' +
  "let's start with|let us start with|let's talk about|elaborate|share|list|name|summari[sz]e|" +
  // Coding tasks: "Take one list of integers...", "Find the second highest number...".
  'take|find|count|sort|reverse|print|remove|check|create|build|convert|merge|calculate|solve|show me|optimi[sz]e|fix|debug';
/** Openers in front of a task: "You need to find...", "Can you write...", "I want you to implement...". */
const TASK_OPENER =
  "you (?:need|have|want|got) to|you(?:'ll| will) (?:need|have) to|you should|i (?:want|need|would like) you to|i'd like you to|" +
  'your task is to|can you|could you|would you|try to';
const REQUEST = `(?:(?:${TASK_OPENER})\\s+)?(?:${REQUEST_VERB})`;
const REQUEST_START = new RegExp(`^(${REQUEST})\\b`, 'i');
const QUESTION_START = new RegExp(
  `^(what|why|how|when|where|which|who|whom|whose|can|could|would|will|should|shall|do|does|did|is|are|was|were|have|has|had|may|might|${REQUEST})\\b`,
  'i',
);

/** Greetings, fillers and linking words before the actual question: "Hello, tell me...", "And you need to...". */
const LEAD_IN =
  /^((good (morning|afternoon|evening)|hello|hi|hey|okay|ok|so|alright|all right|right|now|well|great|good|cool|nice|perfect|fine|next|please|um+|uh+|thanks|thank you|and|again|also|but|then)\b[\s,.!]*)+/i;

/** Acknowledgements and remarks without anything to answer: "Mm-hmm.", "Okay, that's great, nice.", "Moving forward." */
const FILLER = new RegExp(
  '^((' +
    [
      'm+-?h+m+', 'h+m+', 'uh-?huh', 'uh+', 'um+', 'ah+', 'oh', 'yeah', 'yes', 'yep', 'no', 'nope', 'okay', 'ok', 'right', 'sure',
      'alright', 'all right', 'hello', 'hi', 'hey', 'great', 'very good', 'good', 'nice', 'cool', 'fine', 'perfect', 'excellent',
      'awesome', 'amazing', 'wonderful', 'correct', 'exactly', 'absolutely', "that's (?:great|good|nice|fine|right|correct|perfect)",
      '(?:i )?got it', 'i see', 'makes sense', 'fair enough', 'moving (?:on|forward)', 'moving to the next(?: one| question)?',
      "let's move on", 'then', 'so', 'and', 'thanks', 'thank you', 'bye',
    ].join('|') +
    ')\\b[\\s,.!?]*)+$',
  'i',
);

/** Is this line only an acknowledgement, with nothing to answer? */
export function isFiller(text: string): boolean {
  return FILLER.test(text.trim());
}

/** Requests for the candidate's introduction, wherever they appear in the sentence. */
const INTRODUCTION = /\b(introduce yourself|your introduction|about yourself|self[- ]?introduction)\b|^introduction\b/i;

/**
 * "What I did was...", "When we deployed it...": the speaker recounting their own
 * work, not asking. Modal phrasings such as "How we can achieve..." stay questions.
 */
const OWN_ACCOUNT = /^(what|how|when|where|why|which)\s+(i|we)\s+(\w+ed|did|was|were|had|made|built|wrote|got|went|found|chose|ran)\b/i;

/** Topic-style prompts such as "Difference between HashMap and Hashtable" or "The difference between...". */
const TOPIC_START =
  /^(?:the\s+)?(difference between|differences between|internal working|working of|features? of|advantages? of|disadvantages? of|types of|use of|uses of|purpose of|benefits of|example of)\b/i;

/** Statements about the speaker ("I used Spring Boot") are answers, not questions. */
const FIRST_PERSON = /\b(i|i'm|i've|me|my|we|we're|we've|our|us)\b/i;

/** Longest topic-only phrase treated as a question. */
const MAX_TOPIC_WORDS = 8;

/**
 * Heuristic: does this utterance look like a question or an interview prompt?
 * `terms` are vocabulary entries; a short phrase naming one ("Java 8 features")
 * counts as a question even without a question word.
 */
export function looksLikeQuestion(text: string, terms: readonly string[] = []): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  if (t.endsWith('?')) return true;
  if (INTRODUCTION.test(t)) return true;
  // Interviewers often speak prompts without a rising tone; check the last sentence.
  const sentences = t.split(/(?<=[.!?])\s+/);
  const last = sentences[sentences.length - 1] ?? t;
  // A greeting may come first ("Hello, tell me..."). After one, only a request counts:
  // "So when you call put()..." is the speaker explaining, not asking.
  const prompt = last.replace(LEAD_IN, '');
  if (!prompt) return false;
  const words = prompt.split(/\s+/).length;
  const asks = prompt === last ? QUESTION_START.test(last) && !OWN_ACCOUNT.test(last) : REQUEST_START.test(prompt);
  if (asks && words >= 4) return true;
  if (words > MAX_TOPIC_WORDS || FIRST_PERSON.test(prompt)) return false;
  return TOPIC_START.test(prompt) || terms.some((term) => mentionsTerm(prompt, term));
}

/** A line heard within this long after the previous one may be the rest of its sentence. */
export const CONTINUATION_WINDOW_MS = 6000;

/** Articles, prepositions and conjunctions a sentence cannot end on: "work on the." was cut off. */
const DANGLING_END = /\b(the|a|an|of|on|in|at|to|for|with|and|or|between|from|into|about|like|using|than|versus|vs)$/i;

/**
 * Openers that carry on the previous sentence. Reply openers ("Yes", "So", "I")
 * are deliberately absent, so the candidate's own answer is not merged into the question.
 */
const CONTINUATION_START = /^(and|or|also|plus|then|using|with|without|including|especially|compared|versus|vs)\b/i;

/**
 * Is `next` the rest of the sentence that `previous` started? Speakers pause
 * mid-question ("Do you ever work on the..." then "AWS?") or add a clause after a
 * pause ("Write a program using streams." then "And sort the names...").
 */
export function isContinuation(previous: string, next: string): boolean {
  const prev = previous.trim();
  const rest = next.trim();
  if (!prev || !rest) return false;
  // Whisper ends speech cut off by a pause with an ellipsis or a comma.
  const cutOff = /(\.\.\.|…|[,:;-])$/.test(prev) || !/[.?!]$/.test(prev);
  // A question mark means the sentence was finished, even if it ends on a preposition.
  const dangling = !prev.endsWith('?') && DANGLING_END.test(prev.slice(0, -1));
  return cutOff || dangling || CONTINUATION_START.test(rest);
}

/** Join a sentence split by a pause, dropping whisper's trailing ellipsis. */
export function joinFragments(previous: string, next: string): string {
  return `${previous.trim().replace(/(\.\.\.|…)$/, '')} ${next.trim()}`;
}

/** Split a comma-separated vocabulary setting into terms. */
export function vocabularyTerms(vocabulary: string): string[] {
  return vocabulary
    .split(',')
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter(Boolean);
}

/** Whole-word, case-insensitive match that also accepts a plural ("lambdas"). */
function mentionsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\w)${escaped}(?:s|es)?(?!\\w)`, 'i').test(text);
}

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Longest group of clauses checked for a loop: "Java 21, Venice, Titleist, Java 21, Venice, Titleist,". */
const MAX_LOOP_CLAUSES = 4;

/**
 * Whisper loops on unclear audio: "No, no, no, no." or the same sentence several
 * times over. Keep one copy of each run of repeated clauses or words.
 */
export function collapseRepeats(text: string): string {
  // Clauses end at sentence or comma punctuation, which stays attached to them.
  const clauses = text.match(/[^.!?,;]+(?:[.!?,;]+|$)\s*/g) ?? [];
  const keys = clauses.map(normalise);
  let changed = false;
  for (let size = 1; size <= MAX_LOOP_CLAUSES; size++) {
    for (let i = 0; i + 2 * size <= keys.length; ) {
      const repeated = keys.slice(i, i + size).every((k, j) => k !== '' && k === keys[i + size + j]);
      if (!repeated) {
        i++;
        continue;
      }
      // Drop the second copy; the kept one takes its ending, so "No, no." becomes "No.".
      const ending = /[.!?,;]*\s*$/.exec(clauses[i + 2 * size - 1])?.[0] ?? '';
      clauses[i + size - 1] = clauses[i + size - 1].replace(/[.!?,;]*\s*$/, ending);
      clauses.splice(i + size, size);
      keys.splice(i + size, size);
      changed = true;
    }
  }
  const joined = changed ? clauses.join('').trim() : text;
  // Unpunctuated runs: "no no no no".
  return joined.replace(/\b(\w+)(?:\s+\1\b){2,}/gi, '$1');
}

/**
 * Whisper sometimes repeats the tail of the previous segment at the start of
 * the next one. Drop the overlapping words (up to 8) so the transcript reads
 * continuously, and drop exact repeats entirely.
 */
export function removeOverlap(previous: string, next: string): string {
  if (!previous) return next;
  if (normalise(previous) === normalise(next)) return '';
  const prevWords = previous.split(/\s+/);
  const nextWords = next.split(/\s+/);
  const max = Math.min(8, prevWords.length, nextWords.length - 1);
  for (let n = max; n >= 2; n--) {
    const tail = normalise(prevWords.slice(-n).join(' '));
    const head = normalise(nextWords.slice(0, n).join(' '));
    if (tail && tail === head) return nextWords.slice(n).join(' ');
  }
  return next;
}

/** Keep the most recent `maxChars` characters, starting at a word boundary. */
export function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(-maxChars);
  // Already at a word boundary: keep the first word whole.
  if (/^\s/.test(cut) || /\s$/.test(text.slice(0, -maxChars))) return cut.trimStart();
  const space = cut.indexOf(' ');
  return space >= 0 ? cut.slice(space + 1) : cut;
}
