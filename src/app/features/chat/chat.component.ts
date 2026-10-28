import { Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ChatMessage } from '../../../../shared/ipc';
import type { ResponseLength } from '../../../../shared/settings';
import { AiService, AiStream } from '../../core/ai.service';
import { ElectronBridgeService } from '../../core/electron-bridge.service';
import { newId } from '../../core/ids';
import { renderMarkdown } from '../../core/markdown';
import { SettingsService } from '../../core/settings.service';
import { ResponseViewComponent } from '../../shared/response-view.component';
import { revealStart } from '../../shared/scroll';

interface Turn {
  role: ChatMessage['role'];
  content: string;
  html?: string;
}

const STARTERS = [
  'Explain the Java memory model and happens-before',
  'How does Spring Boot auto-configuration work?',
  'Quiz me on SQL joins and indexes',
  'Compare REST and gRPC for microservices',
];

/** Free-form study chat with the local model. */
@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule, ResponseViewComponent],
  template: `
    <section class="panel chat">
      <div class="panel-head">
        <h2>Study chat</h2>
        <span class="spacer"></span>
        <div class="segmented" role="group" aria-label="Response length">
          @for (l of lengths; track l) {
            <button type="button" [class.on]="length() === l" (click)="length.set(l)">{{ l[0].toUpperCase() + l.slice(1) }}</button>
          }
        </div>
        <button type="button" class="btn small ghost" (click)="newChat()" [disabled]="turns().length === 0 && !stream()">New chat</button>
      </div>
      <div class="panel-body">
        @for (t of earlier(); track $index) {
          @if (t.role === 'user') {
            <div class="msg user">{{ t.content }}</div>
          } @else {
            <div class="msg bot">
              <div class="md" [innerHTML]="t.html"></div>
              <button type="button" class="btn small ghost copy" (click)="copy(t.content)">Copy</button>
            </div>
          }
        }
        @if (stream(); as s) {
          <div class="latest" #latest>
            <div class="msg user">{{ latestQuestion() }}</div>
            <div class="msg bot">
              <app-response-view [stream]="s" (regenerate)="retry()" />
            </div>
          </div>
        }
        @if (turns().length === 0 && !stream()) {
          <div class="starters">
            <p class="muted small-text">Ask anything you are studying. Everything runs on your local Ollama model.</p>
            @for (s of starters; track s) {
              <button type="button" class="btn starter" (click)="send(s)">{{ s }}</button>
            }
          </div>
        }
      </div>
      <form class="composer" (ngSubmit)="send()">
        <textarea
          class="textarea"
          rows="2"
          name="draft"
          placeholder="Ask a question (Enter to send, Shift+Enter for a new line)"
          [ngModel]="draft()"
          (ngModelChange)="draft.set($event)"
          (keydown)="onKey($event)"></textarea>
        <button type="submit" class="btn primary" [disabled]="!draft().trim() || busy()">Send</button>
      </form>
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      padding: 0 10px 8px;
    }
    .chat {
      flex: 1;
    }
    .msg {
      margin-bottom: 8px;
      padding: 6px 9px;
      border-radius: 8px;
    }
    .user {
      margin-left: 32px;
      background: var(--accent-soft);
      white-space: pre-wrap;
    }
    .bot {
      position: relative;
      background: var(--surface-2);
    }
    .copy {
      position: absolute;
      right: 2px;
      bottom: 2px;
      opacity: 0;
    }
    .bot:hover .copy {
      opacity: 1;
    }
    /* At least one panel tall, so the question can sit at the top while its answer streams in below. */
    .latest {
      min-height: 100%;
    }
    .starters {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .starter {
      justify-content: flex-start;
      height: auto;
      padding: 6px 10px;
      white-space: normal;
      text-align: left;
    }
    .composer {
      display: flex;
      gap: 6px;
      align-items: flex-end;
      padding: 8px;
      border-top: 1px solid var(--border-muted);
    }
  `,
})
export class ChatComponent {
  private readonly ai = inject(AiService);
  private readonly bridge = inject(ElectronBridgeService);
  private readonly settings = inject(SettingsService);

  readonly lengths: ResponseLength[] = ['short', 'medium', 'detailed'];
  readonly starters = STARTERS;
  readonly turns = signal<Turn[]>([]);
  readonly stream = signal<AiStream | null>(null);
  readonly draft = signal('');
  readonly length = signal<ResponseLength>(this.settings.settings().ai.responseLength);
  readonly busy = computed(() => !!this.stream()?.active);
  /** While an answer is shown, the last turn is its question; it is rendered together with the answer. */
  readonly earlier = computed(() => (this.stream() ? this.turns().slice(0, -1) : this.turns()));
  readonly latestQuestion = computed(() => (this.stream() ? (this.turns().at(-1)?.content ?? '') : ''));

  private sessionId = newId('chat');
  private readonly latest = viewChild<ElementRef<HTMLElement>>('latest');
  private frame = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(this.frame));
  }

  send(text = this.draft()): void {
    const input = text.trim();
    if (!input || this.busy()) return;
    this.draft.set('');
    // A finished answer joins the conversation now rather than when it finished,
    // so it is never re-rendered while it may still be being read. A failed or
    // cancelled answer is dropped.
    const previous = this.stream();
    if (previous?.state() === 'done') {
      const content = previous.text();
      this.turns.update((t) => [...t, { role: 'assistant', content, html: renderMarkdown(content) }]);
    }
    const history: ChatMessage[] = this.turns().map(({ role, content }) => ({ role, content }));
    this.turns.update((t) => [...t, { role: 'user', content: input }]);
    this.stream.set(
      this.ai.run({ mode: 'chat', input, messages: history, length: this.length(), sessionId: this.sessionId, kind: 'chat' }),
    );
    // Once, when sending: put the question at the top so the answer is read from its start.
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      const el = this.latest()?.nativeElement;
      if (el) revealStart(el, { always: true });
    });
  }

  /** Re-send the last user message after an error or to get a different answer. */
  retry(): void {
    const turns = this.turns();
    const lastUser = [...turns].reverse().find((t) => t.role === 'user');
    if (!lastUser) return;
    this.stream()?.cancel();
    const idx = turns.lastIndexOf(lastUser);
    this.turns.set(turns.slice(0, idx));
    this.stream.set(null);
    this.send(lastUser.content);
  }

  newChat(): void {
    this.stream()?.cancel();
    this.stream.set(null);
    this.turns.set([]);
    this.sessionId = newId('chat');
  }

  onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  copy(text: string): void {
    void this.bridge.api.copyText(text);
  }
}
