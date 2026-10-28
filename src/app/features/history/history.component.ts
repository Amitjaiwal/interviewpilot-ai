import { DatePipe } from '@angular/common';
import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { HistorySession, HistorySummary } from '../../../../shared/ipc';
import { ElectronBridgeService } from '../../core/electron-bridge.service';
import { renderMarkdown } from '../../core/markdown';
import { SettingsService } from '../../core/settings.service';

const KIND_LABEL = { live: 'Live', chat: 'Chat', practice: 'Practice' } as const;

/** Searchable local history of transcripts and AI exchanges. */
@Component({
  selector: 'app-history',
  standalone: true,
  imports: [FormsModule, DatePipe],
  template: `
    <section class="panel history">
      @if (open(); as s) {
        <div class="panel-head">
          <button type="button" class="btn small ghost" (click)="open.set(null)">‹ Back</button>
          <h2 class="title">{{ s.title }}</h2>
          <span class="spacer"></span>
          <button type="button" class="btn small ghost" (click)="copySession(s)">{{ copied() ? 'Copied' : 'Copy' }}</button>
          <button type="button" class="btn small ghost" (click)="remove(s.id)">Delete</button>
        </div>
        <div class="panel-body">
          <p class="small-text faint">{{ kind[s.kind] }} · {{ s.startedAt | date: 'medium' }}</p>
          @if (s.transcript.length) {
            <h3>Transcript</h3>
            @for (t of s.transcript; track $index) {
              <p class="line"><span class="who">{{ t.source === 'mic' ? 'You' : 'Meeting' }}</span>{{ t.text }}</p>
            }
          }
          @if (s.exchanges.length) {
            <h3>AI exchanges</h3>
            @for (e of s.exchanges; track $index) {
              <div class="exchange">
                <p class="prompt">{{ e.prompt }}</p>
                <div class="md" [innerHTML]="render(e.response)"></div>
                <p class="small-text faint">{{ e.mode }} · {{ e.model }} · {{ e.at | date: 'shortTime' }}</p>
              </div>
            }
          }
        </div>
      } @else {
        <div class="panel-head">
          <h2>History</h2>
          <span class="spacer"></span>
          <button type="button" class="btn small ghost" (click)="clearAll()" [disabled]="items().length === 0">Delete all</button>
        </div>
        <div class="search">
          <input class="input" type="search" placeholder="Search transcripts and answers" [ngModel]="query()" (ngModelChange)="onQuery($event)" />
        </div>
        @if (!settings.settings().privacy.saveHistory) {
          <div class="warn-box note">Saving history is off. Turn it on in Settings › Privacy to keep new sessions.</div>
        }
        <div class="panel-body">
          @for (item of items(); track item.id) {
            <button type="button" class="item" (click)="show(item.id)">
              <span class="row">
                <span class="kind" [attr.data-kind]="item.kind">{{ kind[item.kind] }}</span>
                <span class="name">{{ item.title }}</span>
              </span>
              @if (item.snippet) {
                <span class="snippet">{{ item.snippet }}</span>
              }
              <span class="small-text faint">
                {{ item.updatedAt | date: 'MMM d, h:mm a' }} · {{ item.transcriptCount }} lines · {{ item.exchangeCount }} answers
              </span>
            </button>
          } @empty {
            <div class="empty">{{ query() ? 'No sessions match your search.' : 'No saved sessions yet.' }}</div>
          }
        </div>
      }
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
    .history {
      flex: 1;
    }
    .title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-transform: none !important;
      letter-spacing: 0 !important;
    }
    .search {
      padding: 8px 10px 0;
    }
    .note {
      margin: 8px 10px 0;
    }
    .item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      width: 100%;
      min-width: 0;
      overflow: hidden;
      .row {
        flex-wrap: nowrap;
      }
      margin-bottom: 6px;
      padding: 7px 9px;
      border: 1px solid var(--border-muted);
      border-radius: 6px;
      background: var(--surface-2);
      color: var(--text);
      font: inherit;
      text-align: left;
      cursor: pointer;
      &:hover {
        border-color: var(--border);
        background: var(--hover);
      }
    }
    .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }
    .kind {
      padding: 0 6px;
      border-radius: 4px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      &[data-kind='chat'] {
        background: rgba(199, 166, 255, 0.14);
        color: #c7a6ff;
      }
      &[data-kind='practice'] {
        background: var(--live-soft);
        color: var(--live);
      }
    }
    .snippet {
      color: var(--text-muted);
      font-size: 12px;
    }
    h3 {
      margin: 10px 0 4px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
    }
    .line {
      margin: 0 0 3px;
    }
    .who {
      display: inline-block;
      width: 60px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-faint);
    }
    .exchange {
      margin-bottom: 10px;
      padding: 8px;
      border-radius: 6px;
      background: var(--surface-2);
    }
    .prompt {
      margin: 0 0 6px;
      font-weight: 600;
      white-space: pre-wrap;
    }
  `,
})
export class HistoryComponent {
  private readonly bridge = inject(ElectronBridgeService);
  readonly settings = inject(SettingsService);

  /** Reload whenever the tab becomes visible. */
  readonly active = input(false);

  readonly kind = KIND_LABEL;
  readonly items = signal<HistorySummary[]>([]);
  readonly open = signal<HistorySession | null>(null);
  readonly query = signal('');
  readonly copied = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      if (this.active()) void this.reload();
    });
  }

  onQuery(q: string): void {
    this.query.set(q);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reload(), 200);
  }

  async reload(): Promise<void> {
    this.items.set(await this.bridge.api.history.list(this.query()));
  }

  async show(id: string): Promise<void> {
    this.open.set(await this.bridge.api.history.get(id));
  }

  async remove(id: string): Promise<void> {
    if (!confirm('Delete this session from history?')) return;
    await this.bridge.api.history.delete(id);
    this.open.set(null);
    await this.reload();
  }

  async clearAll(): Promise<void> {
    if (!confirm('Delete all saved sessions? This cannot be undone.')) return;
    await this.bridge.api.history.clear();
    await this.reload();
  }

  render(md: string): string {
    return renderMarkdown(md);
  }

  async copySession(s: HistorySession): Promise<void> {
    const lines = [
      s.title,
      '',
      ...s.transcript.map((t) => `${t.source === 'mic' ? 'You' : 'Meeting'}: ${t.text}`),
      ...s.exchanges.flatMap((e) => ['', `Q: ${e.prompt}`, '', e.response]),
    ];
    await this.bridge.api.copyText(lines.join('\n'));
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}
