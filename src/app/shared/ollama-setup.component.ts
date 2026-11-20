import { Component, computed, inject } from '@angular/core';
import { RECOMMENDED_OLLAMA_MODEL } from '../../../shared/settings';
import { AiService } from '../core/ai.service';

export function formatSize(bytes: number): string {
  return bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** The steps to get local AI going: install or start Ollama, then download a model. Used in first-run setup and Settings. */
@Component({
  selector: 'app-ollama-setup',
  standalone: true,
  template: `
    <div class="setup">
      @if (!ai.status()?.reachable) {
        @if (ai.status()?.installed) {
          <strong>Step 1 of 2: start Ollama</strong>
          <p>Ollama is installed but not running. Open it from the Start menu, then press Check again.</p>
          <div class="row">
            <button type="button" class="btn primary" (click)="ai.refreshStatus()" [disabled]="ai.checking()">Check again</button>
          </div>
        } @else {
          <strong>Step 1 of 2: install Ollama</strong>
          <p>Ollama is the free program that runs the AI on this PC. Install it, then come back here.</p>
          <div class="row">
            <a class="btn primary" href="https://ollama.com/download/windows" target="_blank" rel="noopener">Download Ollama</a>
            <button type="button" class="btn" (click)="ai.refreshStatus()" [disabled]="ai.checking()">Check again</button>
          </div>
        }
      } @else {
        <strong>Step 2 of 2: download the AI model</strong>
        <p>{{ recommendedModel }}, a one-time download of about 4.7 GB. It needs about 6 GB of free memory while answering.</p>
        @if (ai.pull(); as p) {
          <div class="progress" role="progressbar" aria-label="Model download" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="pullPercent()">
            <span [style.width.%]="pullPercent() ?? 0"></span>
          </div>
          <div class="row nowrap">
            <p>
              @if (p.total) {
                Downloading: {{ pullPercent() }}% ({{ formatSize(p.completed ?? 0) }} of {{ formatSize(p.total) }})
              } @else {
                Please wait…
              }
            </p>
            <span class="spacer"></span>
            <button type="button" class="btn small ghost" (click)="ai.cancelPull()">Cancel</button>
          </div>
        } @else {
          <div class="row">
            <button type="button" class="btn primary" (click)="ai.pullRecommendedModel()">Download model</button>
          </div>
        }
        @if (ai.pullError(); as e) {
          <div class="error-box">{{ e }}</div>
        }
      }
      <ng-content />
    </div>
  `,
  styles: `
    .setup {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: var(--accent-soft);
      font-size: 12px;
    }
    a.btn {
      text-decoration: none;
    }
    p {
      margin: 0;
      font-size: 11px;
      color: var(--text-muted);
    }
    .nowrap {
      flex-wrap: nowrap;
    }
    .progress {
      height: 6px;
      border-radius: 3px;
      background: var(--border);
      overflow: hidden;

      span {
        display: block;
        height: 100%;
        background: var(--accent);
        transition: width 200ms;
      }
    }
  `,
})
export class OllamaSetupComponent {
  readonly ai = inject(AiService);
  readonly recommendedModel = RECOMMENDED_OLLAMA_MODEL;
  readonly formatSize = formatSize;

  /** Download progress in percent, once Ollama has reported how big the current part is. */
  readonly pullPercent = computed(() => {
    const p = this.ai.pull();
    return p?.total ? Math.floor(((p.completed ?? 0) / p.total) * 100) : null;
  });
}
