import { describe, expect, it } from 'vitest';
import {
  cleanTranscript,
  collapseRepeats,
  isContinuation,
  isFiller,
  joinFragments,
  looksLikeQuestion,
  removeOverlap,
  tail,
  vocabularyTerms,
} from '../../shared/text';

describe('cleanTranscript', () => {
  it('strips whisper annotations and extra whitespace', () => {
    expect(cleanTranscript(' [BLANK_AUDIO] Hello   there (coughs) ')).toBe('Hello there');
    expect(cleanTranscript('♪♪ music ♪♪')).toBe('music');
  });

  it('drops segments that are only annotations or known hallucinations', () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript(' Thank you. ')).toBe('');
    expect(cleanTranscript('...')).toBe('');
  });

  it('keeps hallucination phrases inside real sentences', () => {
    expect(cleanTranscript('Thank you for the question about Kafka.')).toBe('Thank you for the question about Kafka.');
  });

  it('collapses repetition loops to one copy', () => {
    // Seen in live sessions on unclear audio.
    expect(cleanTranscript('No, no, no, no, no, no, no, no.')).toBe('No.');
    expect(cleanTranscript('You can see it. You can see it. You can see it.')).toBe('You can see it.');
    expect(cleanTranscript('You need to write your own method, you need to write your own method.')).toBe('You need to write your own method.');
    expect(cleanTranscript('Java 21, Venice, Titleist, Java 21, Venice, Titleist,')).toBe('Java 21, Venice, Titleist,');
    expect(cleanTranscript('Now, now, now, now, now, let us do this.')).toBe('Now, let us do this.');
    expect(cleanTranscript('and and and and')).toBe('and');
    // A doubled hallucination is still a hallucination.
    expect(cleanTranscript('Thank you. Thank you.')).toBe('');
  });

  it('keeps ordinary repetition and text without loops unchanged', () => {
    expect(cleanTranscript('Very, very good.')).toBe('Very, very good.');
    expect(cleanTranscript('What is the... purpose of a bean?')).toBe('What is the... purpose of a bean?');
    expect(cleanTranscript('So you need to find the second highest number on that list.')).toBe(
      'So you need to find the second highest number on that list.',
    );
  });
});

describe('collapseRepeats', () => {
  it('keeps the ending of the last copy', () => {
    expect(collapseRepeats('How do you manage? How do you manage?')).toBe('How do you manage?');
    expect(collapseRepeats('It is done. It is done.')).toBe('It is done.');
  });
});

describe('isFiller', () => {
  it('recognises acknowledgements with nothing to answer', () => {
    expect(isFiller('Mm-hmm.')).toBe(true);
    expect(isFiller('Mm-hm.')).toBe(true);
    expect(isFiller('Okay, yeah.')).toBe(true);
    expect(isFiller('No.')).toBe(true);
    // Interviewer remarks from live sessions.
    expect(isFiller("Okay, that's great, nice.")).toBe(true);
    expect(isFiller("Oh, that's great. Okay. I got it.")).toBe(true);
    expect(isFiller('So moving to the next.')).toBe(true);
    expect(isFiller('Moving forward.')).toBe(true);
  });

  it('does not treat content as filler', () => {
    expect(isFiller('Okay, explain streams.')).toBe(false);
    expect(isFiller('Using streams.')).toBe(false);
  });
});

describe('looksLikeQuestion', () => {
  it('detects explicit questions', () => {
    expect(looksLikeQuestion('What is dependency injection?')).toBe(true);
  });

  it('detects spoken prompts without a question mark', () => {
    expect(looksLikeQuestion('Okay great. Explain how garbage collection works in Java')).toBe(true);
    expect(looksLikeQuestion('Tell me about a project you are proud of.')).toBe(true);
  });

  it('ignores statements and fragments', () => {
    expect(looksLikeQuestion('I worked on the payments team for two years.')).toBe(false);
    expect(looksLikeQuestion('Why?')).toBe(false);
  });

  it('detects short topic prompts that name a vocabulary term', () => {
    const terms = vocabularyTerms('Java, Java 8, HashMap, lambda, Spring Boot, Big-O.');
    expect(terms).toEqual(['Java', 'Java 8', 'HashMap', 'lambda', 'Spring Boot', 'Big-O']);
    expect(looksLikeQuestion('Java 8 feature.', terms)).toBe(true);
    expect(looksLikeQuestion('Internal working of HashMap.', terms)).toBe(true);
    expect(looksLikeQuestion('Lambdas in Java', terms)).toBe(true);
    expect(looksLikeQuestion('Difference between abstract class and interface.')).toBe(true);
  });

  it('looks past greetings and fillers in front of the question', () => {
    expect(looksLikeQuestion('Hello, tell me the multiple inheritance and OOPs concept in Java.')).toBe(true);
    expect(looksLikeQuestion('Hello, tell me the features of Java 8.')).toBe(true);
    expect(looksLikeQuestion('Okay, so, explain the Java memory model')).toBe(true);
    expect(looksLikeQuestion('Good morning, walk me through your last project.')).toBe(true);
    expect(looksLikeQuestion('Please explain the difference between process and thread.')).toBe(true);
    expect(looksLikeQuestion('Hello, hello, hello, hello, hello, hello, hello.')).toBe(false);
  });

  it('detects coding tasks given as instructions', () => {
    // Prompts from a live session that were not auto-answered before.
    expect(looksLikeQuestion('So you need to find the first non-repeated character from a string.')).toBe(true);
    expect(looksLikeQuestion('And you need to count the frequency of each element.')).toBe(true);
    expect(looksLikeQuestion('Again, take a list of strings.')).toBe(true);
    expect(looksLikeQuestion('You need to write one program using streams.')).toBe(true);
    expect(looksLikeQuestion('Can you write a program to reverse a string')).toBe(true);
    expect(looksLikeQuestion('I want you to implement an LRU cache.')).toBe(true);
    // The candidate describing their own steps is not a task.
    expect(looksLikeQuestion('I need to take the string first.')).toBe(false);
  });

  it('detects topic prompts that start with "the"', () => {
    expect(looksLikeQuestion('The difference between REST controller and control app.')).toBe(true);
    expect(looksLikeQuestion('The difference between the rest, controller and controller.')).toBe(true);
  });

  it('detects requests for an introduction', () => {
    expect(looksLikeQuestion('Introduction.')).toBe(true);
    expect(looksLikeQuestion('Start with your introduction.')).toBe(true);
    expect(looksLikeQuestion('Please give your introduction.')).toBe(true);
    expect(looksLikeQuestion('Introduce yourself.')).toBe(true);
  });

  it('treats the speaker recounting their own work as an answer, not a question', () => {
    expect(looksLikeQuestion('So, what we did was move the batch jobs to Kafka.')).toBe(false);
    expect(looksLikeQuestion('When I was at Volkswagen we used Feign clients.')).toBe(false);
    expect(looksLikeQuestion('So when you get that, hash, so when you lift it.')).toBe(false);
    expect(looksLikeQuestion('So what happens is the map resizes.')).toBe(false);
    // Questions phrased without inversion still count.
    expect(looksLikeQuestion('How we can achieve multiple inheritance in Java.')).toBe(true);
  });

  it('ignores first-person statements, long remarks and phrases without a term', () => {
    const terms = vocabularyTerms('Java, Spring Boot');
    expect(looksLikeQuestion('I used Spring Boot there.', terms)).toBe(false);
    expect(looksLikeQuestion('Bless you, Liberty.', terms)).toBe(false);
    expect(looksLikeQuestion('So the whole team moved the billing service to Java last year after the outage.', terms)).toBe(false);
  });
});

describe('isContinuation', () => {
  it('joins the rest of a question that was cut off by a pause', () => {
    expect(isContinuation('Do you ever work on the...', 'AWS?')).toBe(true);
    expect(isContinuation('What is the difference between', 'HashMap and Hashtable?')).toBe(true);
    expect(isContinuation('Explain the difference between.', 'checked and unchecked exceptions.')).toBe(true);
  });

  it('joins a clause added after a pause', () => {
    expect(isContinuation('Write a programming stream.', 'And sort the names according to their first letter.')).toBe(true);
    expect(isContinuation('What is a HashMap?', 'Also, how is it different from a TreeMap?')).toBe(true);
  });

  it('keeps finished questions and replies apart', () => {
    expect(isContinuation('What is Java 8 feature?', 'What is RxJS in Angular?')).toBe(false);
    expect(isContinuation('Do you ever work on AWS?', 'Yes, I have used S3 and Lambda.')).toBe(false);
    expect(isContinuation('Which team are you working with?', 'So I am in the payments team.')).toBe(false);
  });
});

describe('joinFragments', () => {
  it('drops the ellipsis at the cut', () => {
    expect(joinFragments('Do you ever work on the...', 'AWS?')).toBe('Do you ever work on the AWS?');
    expect(joinFragments('Write a program.', 'And sort it.')).toBe('Write a program. And sort it.');
  });
});

describe('removeOverlap', () => {
  it('removes words repeated from the previous segment', () => {
    expect(removeOverlap('we use Kafka for event streaming', 'event streaming and Redis for caching')).toBe(
      'and Redis for caching',
    );
  });

  it('drops an exact repeat', () => {
    expect(removeOverlap('Can you hear me?', 'can you hear me')).toBe('');
  });

  it('leaves unrelated text alone', () => {
    expect(removeOverlap('first sentence here', 'second one entirely')).toBe('second one entirely');
    expect(removeOverlap('', 'anything')).toBe('anything');
  });
});

describe('tail', () => {
  it('returns short text unchanged', () => {
    expect(tail('short', 100)).toBe('short');
  });

  it('cuts at a word boundary', () => {
    expect(tail('alpha beta gamma delta', 12)).toBe('gamma delta');
    expect(tail('alpha beta gamma delta', 10)).toBe('delta');
  });
});
