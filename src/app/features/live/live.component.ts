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

/**
 * split: AI response on top, transcript and audio controls below, divider adjustable.
 * ai: the AI response fills the window and the lower section is hidden (capture keeps running).
 * transcript: the AI response shrinks to make room for the transcript.
 */
export type LayoutMode = 'split' | 'ai' | 'transcript';

/** The height the two panels share, how much of it the AI response has, and the smallest each may have. */
interface Measured {
  ai: number;
  total: number;
  minAi: number;
  minLower: number;
}

/**
 * Neither panel may be dragged smaller than its minimum: a fixed size, or in a very short window
 * a share of the height, so that both always fit. Keep these in step with live.component.scss.
 */
const MIN_AI_PX = 200;
const MIN_AI_SHARE = 0.55;
const MIN_LOWER_PX = 150;
const MIN_LOWER_SHARE = 0.34;
/** Share of the space the AI response gets at first, and in the "transcript" layout. */
const DEFAULT_SPLIT = 0.6;
const TRANSCRIPT_LAYOUT_AI_SHARE = 0.3;
/** Arrow keys on the divider move it by this share of the space, at least MIN_KEY_STEP_PX. */
const KEY_STEP = 0.05;
const MIN_KEY_STEP_PX = 24;

@Component({
  selector: 'app-live',
  standalone: true,
  imports: [FormsModule, ResponseViewComponent],
  templateUrl: './live.component.html',
  styleUrl: './live.component.scss',
  host: { '[class.dragging]': 'dragging()' },
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

  // ------------------------------------------------------------ layout (view only)

  readonly layout = signal<LayoutMode>('split');
  /** The AI response's share of the space in the "split" layout. Kept when switching to another layout. */
  readonly split = signal(DEFAULT_SPLIT);
  readonly dragging = signal(false);
  private readonly aiShare = computed(() => {
    const mode = this.layout();
    return mode === 'ai' ? 1 : mode === 'transcript' ? TRANSCRIPT_LAYOUT_AI_SHARE : this.split();
  });
  /** flex-grow values: only their ratio matters, so the panels keep their proportions when the window is resized. */
  readonly aiGrow = computed(() => this.aiShare() * 100);
  readonly lowerGrow = computed(() => (1 - this.aiShare()) * 100);
  readonly aiShareLabel = computed(() => Math.round(this.aiShare() * 100));
  /** Shown on the divider while the lower section is hidden, so capture is still visible at a glance. */
  readonly collapsedHint = computed(() => {
    const status = this.engineLabel();
    return status ? `Transcript hidden · ${status}` : 'Transcript hidden';
  });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly answerPanel = viewChild<ElementRef<HTMLElement>>('answerPanel');
  private readonly lowerSection = viewChild<ElementRef<HTMLElement>>('lower');
  private drag: ({ y: number } & Measured) | null = null;
  /** Whether the transcript was scrolled to its newest line when it last scrolled; a resize does not change that. */
  private following = true;

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

    // Resizing the panel (divider, layout buttons, window) must not push the newest line out of sight.
    effect((onCleanup) => {
      const el = this.scroller()?.nativeElement;
      if (!el) return;
      const observer = new ResizeObserver(() => {
        if (this.following) el.scrollTop = el.scrollHeight;
      });
      observer.observe(el);
      onCleanup(() => observer.disconnect());
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

  // ------------------------------------------------------------ layout

  /**
   * Switch between the three layouts. Only what is shown changes: the lower section is
   * hidden, not destroyed, so capture, transcription and AI requests carry on unaffected.
   */
  setLayout(next: LayoutMode): void {
    this.layout.set(next);
  }

  /** Remembers whether the reader is at the newest line, so a resize can keep it in view. */
  onTranscriptScroll(): void {
    const el = this.scroller()?.nativeElement;
    if (el) this.following = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  /** Back to the starting layout and proportions. */
  onDividerDoubleClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('button')) return;
    this.split.set(DEFAULT_SPLIT);
    this.setLayout('split');
  }

  onDividerDown(event: PointerEvent): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const measured = this.measure();
    if (!measured) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.drag = { y: event.clientY, ...measured };
    this.dragging.set(true);
  }

  onDividerMove(event: PointerEvent): void {
    if (this.drag) this.place(this.drag.ai + event.clientY - this.drag.y, this.drag);
  }

  onDividerUp(): void {
    this.drag = null;
    this.dragging.set(false);
  }

  onDividerKey(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    const measured = this.measure();
    // Nothing lies below the divider while the lower section is hidden.
    if (!measured || (direction > 0 && this.layout() === 'ai')) return;
    this.place(measured.ai + direction * Math.max(MIN_KEY_STEP_PX, measured.total * KEY_STEP), measured);
  }

  /** Null when the window is too short to divide at all. */
  private measure(): Measured | null {
    const ai = this.answerPanel()?.nativeElement.offsetHeight ?? 0;
    // A hidden lower section is out of the layout and shares nothing.
    const lower = this.layout() === 'ai' ? 0 : (this.lowerSection()?.nativeElement.offsetHeight ?? 0);
    const total = ai + lower;
    // CSS percentages refer to the host's content box, which excludes its bottom padding.
    const host = this.host.nativeElement;
    const height = host.clientHeight - (parseFloat(getComputedStyle(host).paddingBottom) || 0);
    const minAi = Math.min(MIN_AI_PX, height * MIN_AI_SHARE);
    const minLower = Math.min(MIN_LOWER_PX, height * MIN_LOWER_SHARE);
    return total >= minAi + minLower ? { ai, total, minAi, minLower } : null;
  }

  /** Give the AI response `aiPx` of the shared height, keeping both panels at least their minimum size. */
  private place(aiPx: number, m: Measured): void {
    const clamped = Math.min(Math.max(aiPx, m.minAi), m.total - m.minLower);
    this.split.set(clamped / m.total);
    this.setLayout('split');
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
