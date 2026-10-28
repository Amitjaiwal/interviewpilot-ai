import { Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { AiStream } from '../core/ai.service';
import { ElectronBridgeService } from '../core/electron-bridge.service';
import { renderMarkdown } from '../core/markdown';
import { revealStart } from './scroll';

/** Renders one streamed AI response with copy, stop, regenerate and retry. */
@Component({
  selector: 'app-response-view',
  standalone: true,
  host: { '[class.has-stream]': '!!stream()' },
  template: `
    @if (stream(); as s) {
      <div class="meta">
        @switch (s.state()) {
          @case ('pending') {
            <span class="spinner"></span><span>Waiting for the model…</span>
          }
          @case ('streaming') {
            <span class="spinner"></span><span>Generating with {{ s.model() }}…</span>
          }
          @case ('done') {
            <span class="faint">{{ s.model() }} · {{ (s.durationMs() / 1000).toFixed(1) }}s</span>
          }
          @case ('cancelled') {
            <span class="faint">Stopped</span>
          }
        }
        <span class="spacer"></span>
        @if (s.active) {
          <button type="button" class="btn small" (click)="s.cancel()">Stop</button>
        } @else if (s.text()) {
          <button type="button" class="btn small ghost" (click)="copy(s.text())">{{ copied() ? 'Copied' : 'Copy' }}</button>
          @if (regenerable()) {
            <button type="button" class="btn small ghost" (click)="regenerate.emit()">Regenerate</button>
          }
        }
      </div>
      @if (s.error(); as err) {
        <div class="error-box">
          {{ err }}
          <div class="row retry">
            <button type="button" class="btn small" (click)="regenerate.emit()">Retry</button>
          </div>
        </div>
      }
      <div class="md" [innerHTML]="html()" (click)="onBodyClick($event)"></div>
    } @else {
      <div class="empty">{{ placeholder() }}</div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    /* At least as tall as the scrolling panel, so an answer's first line can sit at
       the top while the rest streams in below (no effect where the parent has no definite height). */
    :host(.has-stream) {
      min-height: 100%;
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 24px;
      margin-bottom: 4px;
      font-size: 11px;
      color: var(--text-muted);
    }
    .error-box {
      margin-bottom: 8px;
    }
    .retry {
      margin-top: 6px;
    }
  `,
})
export class ResponseViewComponent {
  private readonly bridge = inject(ElectronBridgeService);

  readonly stream = input<AiStream | null>(null);
  readonly placeholder = input('Responses appear here.');
  readonly regenerable = input(true);
  readonly regenerate = output<void>();

  readonly copied = signal(false);
  readonly html = computed(() => renderMarkdown(this.stream()?.text() ?? ''));
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // A new answer starts where it can be read from its first line. After that
    // this component never scrolls: streamed text is added below without moving
    // the view, and the reader scrolls freely while generation continues.
    let shown: AiStream | null = null;
    let frame = 0;
    effect(() => {
      const s = this.stream();
      if (!s || s === shown) return;
      shown = s;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => revealStart(this.host.nativeElement));
    });
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(frame));
  }

  async copy(text: string): Promise<void> {
    await this.bridge.api.copyText(text);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  /** Code-block copy buttons live inside [innerHTML], so handle them by delegation. */
  onBodyClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.classList.contains('copy-code')) return;
    const code = target.closest('.code')?.querySelector('code')?.textContent ?? '';
    void this.bridge.api.copyText(code);
    target.textContent = 'Copied';
    setTimeout(() => (target.textContent = 'Copy'), 1500);
  }
}
