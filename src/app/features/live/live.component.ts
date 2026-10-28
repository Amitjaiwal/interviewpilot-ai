import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { AiMode } from '../../../../shared/ipc';
import type { AudioSource, ResponseLength } from '../../../../shared/settings';
import { CONTINUATION_WINDOW_MS, isContinuation, isFiller, joinFragments, looksLikeQuestion, tail, vocabularyTerms } from '../../../../shared/text';
import { AiService, AiStream } from '../../core/ai.service';
import { ElectronBridgeService } from '../../core/electron-bridge.service';
import { SettingsService } from '../../core/settings.service';
import { FinalSegment, TranscriptService } from '../../core/transcript.service';

/** Longest question built from joined fragments; beyond this it is a monologue, not a question. */
const MAX_JOINED_CHARS = 600;
/** Silence after which the other side's next line starts a new turn. */
const NEW_TURN_MS = 12_000;
/** Pause after a line that is not a question before it is answered, in case more follows. */
const TURN_END_MS = 2_500;
/** Longest extra wait while a provisional line shows the speaker is still talking. */
const MAX_TURN_WAIT_MS = 10_000;
import { ResponseViewComponent } from '../../shared/response-view.component';

@Component({
  selector: 'app-live',
  standalone: true,
  imports: [FormsModule, ResponseViewComponent],
  templateUrl: './live.component.html',
  styleUrl: './live.component.scss',
})
export class LiveComponent {
  readonly transcript = inject(TranscriptService);
  private readonly ai = inject(AiService);
  private readonly settingsService = inject(SettingsService);
  private readonly bridge = inject(ElectronBridgeService);

  readonly settings = this.settingsService.settings;
  readonly question = signal('');
  readonly stream = signal<AiStream | null>(null);
  readonly askError = signal<string | null>(null);
  readonly showConsent = signal(false);
  readonly copiedTranscript = signal(false);
  readonly length = computed(() => this.settings().ai.responseLength);
  readonly sources = computed(() => this.settings().stt.sources);
  readonly engineLabel = computed(() => {
    const s = this.transcript.status();
    if (s.capture === 'idle') return '';
    if (s.engine === 'starting') return 'Loading speech model…';
    if (s.engine === 'error') return 'Speech engine error';
    if (s.queue > 0) return `Transcribing (${s.queue})…`;
    return s.capture === 'paused' ? 'Paused' : 'Listening';
  });

  private lastRequest: { mode: AiMode; input: string; context: string } | null = null;
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  /** The latest transcript line, with fragments heard moments apart joined ("work on the..." + "AWS?"). */
  private heard: { source: AudioSource; text: string; at: number; question: boolean } | null = null;
  /** The latest heard question (joined as above) and when it arrived. */
  private lastQuestion: { text: string; at: number } | null = null;
  /** The other side's current turn since that question, e.g. a coding task given in plain sentences. */
  private afterQuestion: { text: string; at: number; since: number } | null = null;
  /** Pending auto-answer of afterQuestion, fired when the speaker pauses. */
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the user last typed in the question box or selected transcript lines. */
  private userEditAt = 0;

  constructor() {
    // Selecting transcript lines fills the question box.
    effect(() => {
      const text = this.transcript.selectedText();
      if (text) {
        this.question.set(text);
        this.userEditAt = Date.now();
      }
    }, { allowSignalWrites: true });

    // Keep the transcript scrolled to the newest line unless the user scrolled up.
    effect(() => {
      this.transcript.segments();
      const el = this.scroller()?.nativeElement;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });

    this.transcript.finals$.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((seg) => this.onFinal(seg));
    inject(DestroyRef).onDestroy(() => this.cancelTurnAnswer());
  }

  /**
   * Track the latest question, joining a fragment that completes the previous
   * line, and auto-answer it. The newest question always wins: a continuation or
   * a new question replaces an answer that is still being written. Lines that are
   * not questions are collected for Suggest answer, so it never repeats a stale question,
   * and with "answer every line" they are answered too once the speaker pauses.
   */
  private onFinal(seg: FinalSegment): void {
    // With both sources active, only the other side's questions count.
    if (this.transcript.activeSources().length > 1 && seg.source !== 'system') return;
    const prev = this.heard;
    const joined =
      prev !== null &&
      prev.source === seg.source &&
      seg.at - prev.at <= CONTINUATION_WINDOW_MS &&
      prev.text.length + seg.text.length < MAX_JOINED_CHARS &&
      isContinuation(prev.text, seg.text);
    const text = joined ? joinFragments(prev.text, seg.text) : seg.text;
    // The rest of a question is part of the question, even when it does not look like one alone ("AWS?"),
    // and a question stays one when its start was misheard ("But I do four pillars of..." + "OOP in Java.").
    const question = joined
      ? prev.question || seg.question || looksLikeQuestion(text, vocabularyTerms(this.settings().stt.vocabulary))
      : seg.question;
    this.heard = { source: seg.source, text, at: seg.at, question };
    if (!question) {
      if (!isFiller(seg.text)) {
        const now = Date.now();
        const turn = this.afterQuestion && now - this.afterQuestion.at <= NEW_TURN_MS ? this.afterQuestion : null;
        this.afterQuestion = { text: tail(turn ? `${turn.text} ${seg.text}` : seg.text, MAX_JOINED_CHARS), at: now, since: turn?.since ?? now };
        const { autoAnswer, answerEveryLine } = this.settings().ai;
        if (autoAnswer && answerEveryLine) this.scheduleTurnAnswer(seg.source);
      }
      return;
    }
    this.cancelTurnAnswer();
    this.afterQuestion = null;
    this.lastQuestion = { text, at: Date.now() };
    if (this.settings().ai.autoAnswer) this.ask('answer');
  }

  /** Answer what the other side said once they pause, unless more follows first. */
  private scheduleTurnAnswer(source: AudioSource, waited = 0): void {
    this.cancelTurnAnswer();
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      // A provisional line means they are still talking: wait for the rest, up to a limit.
      const talking = this.transcript.segments().some((s) => s.partial && s.source === source);
      if (talking && waited < MAX_TURN_WAIT_MS) return this.scheduleTurnAnswer(source, waited + TURN_END_MS);
      const said = this.afterQuestion;
      if (!said) return;
      // A follow-up right after a question belongs to it: "...microservices in Java." + "And how we use it in your project."
      const asked = this.lastQuestion;
      const text = asked && said.since - asked.at <= NEW_TURN_MS ? tail(`${asked.text} ${said.text}`, MAX_JOINED_CHARS) : said.text;
      this.afterQuestion = null;
      this.lastQuestion = { text, at: Date.now() };
      this.ask('answer');
    }, TURN_END_MS);
  }

  private cancelTurnAnswer(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  onQuestionInput(text: string): void {
    this.question.set(text);
    this.userEditAt = Date.now();
  }

  // ------------------------------------------------------------ capture

  async start(): Promise<void> {
    if (!this.settings().privacy.captureConsent) {
      this.showConsent.set(true);
      return;
    }
    const s = this.sources();
    const list = (Object.keys(s) as AudioSource[]).filter((k) => s[k]);
    if (list.length === 0) {
      this.transcript.error.set('Select at least one audio source (Mic or System).');
      return;
    }
    await this.transcript.start(list);
  }

  async acceptConsent(): Promise<void> {
    await this.settingsService.update({ privacy: { captureConsent: true } });
    this.showConsent.set(false);
    await this.start();
  }

  toggleSource(source: AudioSource): void {
    const current = this.sources();
    void this.settingsService.update({ stt: { sources: { ...current, [source]: !current[source] } } });
  }

  meter(source: AudioSource): number {
    return Math.min(100, Math.round(this.transcript.levels()[source] * 600));
  }

  async copyTranscript(): Promise<void> {
    await this.bridge.api.copyText(this.transcript.asText());
    this.copiedTranscript.set(true);
    setTimeout(() => this.copiedTranscript.set(false), 1500);
  }

  clearTranscript(): void {
    this.transcript.clear();
    this.question.set('');
    this.heard = null;
    this.lastQuestion = null;
    this.afterQuestion = null;
    this.cancelTurnAnswer();
  }

  // ---------------------------------------------------------------- AI

  setLength(length: ResponseLength): void {
    void this.settingsService.update({ ai: { responseLength: length } });
  }

  useLastQuestion(): void {
    const q = this.lastQuestion?.text ?? (this.transcript.lastQuestion() ?? this.transcript.finals().at(-1))?.text;
    if (q) this.question.set(q);
  }

  ask(mode: AiMode): void {
    // This request covers what was said so far; a pending turn answer would only replace it.
    this.cancelTurnAnswer();
    // Text in the box goes stale when something newer is heard; the user's own typing
    // or selection is kept unless the line arrived after it. Lines heard after the last
    // question (a task given in plain sentences) are newer than it, so they win.
    const latest = this.afterQuestion ?? this.lastQuestion;
    if (latest && latest.at > this.userEditAt) this.question.set(latest.text);
    const input =
      this.question().trim() ||
      this.transcript.selectedText() ||
      this.transcript.lastQuestion()?.text ||
      '';
    if (!input) {
      this.askError.set('Type a question, or click transcript lines to select them.');
      return;
    }
    this.askError.set(null);
    this.run(mode, input, this.transcript.recentContext());
  }

  /** Global shortcut: answer the latest heard question, or what the user typed or selected after it. */
  askFromShortcut(): void {
    if (!this.question().trim()) this.useLastQuestion();
    this.ask('answer');
  }

  regenerate(): void {
    if (this.lastRequest) this.run(this.lastRequest.mode, this.lastRequest.input, this.lastRequest.context);
  }

  onQuestionKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.ask('answer');
    }
  }

  private run(mode: AiMode, input: string, context: string): void {
    this.stream()?.cancel();
    this.lastRequest = { mode, input, context };
    this.transcript.clearSelection();
    this.stream.set(
      this.ai.run({
        mode,
        input,
        context,
        length: this.length(),
        sessionId: this.transcript.sessionId,
        kind: 'live',
      }),
    );
  }
}
