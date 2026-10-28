import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { AiService, AiStream } from '../../core/ai.service';
import { newId } from '../../core/ids';
import { SettingsService } from '../../core/settings.service';
import { TranscriptService } from '../../core/transcript.service';
import { ResponseViewComponent } from '../../shared/response-view.component';
import { Level, QUESTION_BANK, parseQuestionList, parseScore, sampleQuestions } from './question-bank';

const RESUME = 'resume';
const MOCK_LENGTH = 5;

interface MockState {
  scores: (number | null)[];
  finished: boolean;
}

@Component({
  selector: 'app-practice',
  standalone: true,
  imports: [FormsModule, ResponseViewComponent],
  templateUrl: './practice.component.html',
  styleUrl: './practice.component.scss',
})
export class PracticeComponent {
  private readonly ai = inject(AiService);
  private readonly settings = inject(SettingsService);
  private readonly transcript = inject(TranscriptService);

  readonly categories = QUESTION_BANK;
  readonly levels: (Level | 'all')[] = ['all', 'basic', 'intermediate', 'advanced'];
  readonly RESUME = RESUME;

  readonly sourceId = signal(QUESTION_BANK[0].id);
  readonly level = signal<Level | 'all'>('all');
  readonly questions = signal<string[]>(sampleQuestions(QUESTION_BANK[0], 50));
  readonly index = signal(0);
  readonly answer = signal('');
  readonly stream = signal<AiStream | null>(null);
  readonly streamKind = signal<'evaluate' | 'model' | null>(null);
  readonly generator = signal<AiStream | null>(null);
  readonly mock = signal<MockState | null>(null);
  readonly dictating = signal(false);
  readonly notice = signal<string | null>(null);

  readonly hasResume = computed(() => this.settings.settings().profile.resumeText.trim().length > 0);
  readonly current = computed(() => this.questions()[this.index()] ?? '');
  readonly mockAverage = computed(() => {
    const scores = (this.mock()?.scores ?? []).filter((s): s is number => s !== null);
    return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  });

  private sessionId = newId('practice');
  private startedCapture = false;

  constructor() {
    // Personalised questions: parse the generated list once it completes.
    effect(() => {
      const g = this.generator();
      if (g?.state() !== 'done') return;
      const list = parseQuestionList(g.text());
      if (list.length) {
        this.setQuestions(list);
        this.notice.set(null);
      } else {
        this.notice.set('The model did not return a question list. Try again.');
      }
      this.generator.set(null);
    }, { allowSignalWrites: true });

    // Record mock-interview scores as evaluations complete.
    effect(() => {
      const s = this.stream();
      const m = this.mock();
      if (!s || !m || this.streamKind() !== 'evaluate' || s.state() !== 'done') return;
      const score = parseScore(s.text());
      // This effect also reads mock(); only write on a real change to avoid re-triggering itself.
      if (m.scores[this.index()] === score) return;
      const scores = m.scores.slice();
      scores[this.index()] = score;
      this.mock.set({ ...m, scores });
    }, { allowSignalWrites: true });

    this.transcript.finals$.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((seg) => {
      if (this.dictating() && seg.source === 'mic') {
        this.answer.update((a) => (a ? `${a} ${seg.text}` : seg.text));
      }
    });
  }

  selectSource(id: string): void {
    this.sourceId.set(id);
    this.endMock();
    if (id === RESUME) {
      this.setQuestions([]);
      return;
    }
    this.reshuffle();
  }

  selectLevel(level: Level | 'all'): void {
    this.level.set(level);
    if (this.sourceId() !== RESUME) this.reshuffle();
  }

  reshuffle(): void {
    const cat = QUESTION_BANK.find((c) => c.id === this.sourceId());
    if (cat) this.setQuestions(sampleQuestions(cat, 50, this.level()));
  }

  generateFromResume(): void {
    if (!this.hasResume()) {
      this.notice.set('Add your resume in Settings > Profile first.');
      return;
    }
    this.generator()?.cancel();
    const role = this.settings.settings().profile.targetRole || 'the candidate\'s target role';
    this.generator.set(this.ai.run({ mode: 'generate-questions', input: '8', question: `Mixed questions for ${role}` }));
  }

  move(delta: number): void {
    const n = this.questions().length;
    if (!n) return;
    this.index.set(Math.min(n - 1, Math.max(0, this.index() + delta)));
    this.resetAnswer();
  }

  startMock(): void {
    const qs = this.questions();
    if (qs.length === 0) return;
    const set = qs.slice(this.index(), this.index() + MOCK_LENGTH);
    this.setQuestions(set.length >= MOCK_LENGTH ? set : qs.slice(0, MOCK_LENGTH));
    this.mock.set({ scores: Array(this.questions().length).fill(null), finished: false });
    this.sessionId = newId('practice');
  }

  nextMock(): void {
    const m = this.mock();
    if (!m) return;
    if (this.index() >= this.questions().length - 1) this.mock.set({ ...m, finished: true });
    else this.move(1);
  }

  endMock(): void {
    this.mock.set(null);
  }

  evaluate(): void {
    this.run('evaluate');
  }

  modelAnswer(): void {
    this.run('model');
  }

  regenerate(): void {
    const kind = this.streamKind();
    if (kind) this.run(kind);
  }

  async toggleDictation(): Promise<void> {
    if (this.dictating()) {
      this.dictating.set(false);
      if (this.startedCapture) await this.transcript.stop();
      this.startedCapture = false;
      return;
    }
    if (!this.settings.settings().privacy.captureConsent) {
      this.notice.set('Start capture once from the Live tab to accept the microphone notice, then dictate here.');
      return;
    }
    if (this.transcript.capture() === 'idle') {
      await this.transcript.start(['mic']);
      this.startedCapture = this.transcript.capture() !== 'idle';
      if (!this.startedCapture) {
        this.notice.set(this.transcript.error() ?? 'Could not start the microphone.');
        return;
      }
    }
    this.dictating.set(true);
  }

  private run(kind: 'evaluate' | 'model'): void {
    const question = this.current();
    if (!question) return;
    this.stream()?.cancel();
    this.streamKind.set(kind);
    this.stream.set(
      kind === 'evaluate'
        ? this.ai.run({ mode: 'evaluate', question, input: this.answer(), sessionId: this.sessionId, kind: 'practice' })
        : this.ai.run({ mode: 'answer', input: question, sessionId: this.sessionId, kind: 'practice' }),
    );
  }

  private setQuestions(list: string[]): void {
    this.questions.set(list);
    this.index.set(0);
    this.resetAnswer();
  }

  private resetAnswer(): void {
    this.stream()?.cancel();
    this.stream.set(null);
    this.streamKind.set(null);
    this.answer.set('');
  }
}
