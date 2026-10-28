import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type { SttEvent, SttStatus } from '../../../shared/ipc';
import type { AudioSource } from '../../../shared/settings';
import { cleanIpcError } from './ai.service';
import { AudioCapture } from './audio-capture';
import { ElectronBridgeService } from './electron-bridge.service';
import { newId } from './ids';
import { SettingsService } from './settings.service';

export interface TranscriptSegment {
  id: string;
  source: AudioSource;
  text: string;
  partial: boolean;
  at: number;
  question: boolean;
}

export type FinalSegment = TranscriptSegment & { partial: false };

const IDLE: SttStatus = { engine: 'stopped', capture: 'idle', queue: 0 };
const MAX_SEGMENTS = 2000;

/**
 * Live transcription state for the renderer: owns audio capture, forwards PCM
 * to the main process and assembles partial/final segments into a transcript.
 */
@Injectable({ providedIn: 'root' })
export class TranscriptService {
  private readonly bridge = inject(ElectronBridgeService);
  private readonly settings = inject(SettingsService);

  readonly segments = signal<TranscriptSegment[]>([]);
  readonly status = signal<SttStatus>(IDLE);
  readonly levels = signal<Record<AudioSource, number>>({ mic: 0, system: 0 });
  readonly activeSources = signal<AudioSource[]>([]);
  readonly error = signal<string | null>(null);
  readonly starting = signal(false);
  readonly selected = signal<ReadonlySet<string>>(new Set());

  readonly capture = computed(() => this.status().capture);
  readonly recording = computed(() => this.capture() === 'recording');
  readonly finals = computed(() => this.segments().filter((s) => !s.partial));
  readonly lastQuestion = computed(() => [...this.finals()].reverse().find((s) => s.question) ?? null);
  readonly selectedText = computed(() => {
    const sel = this.selected();
    return this.finals()
      .filter((s) => sel.has(s.id))
      .map((s) => s.text)
      .join(' ');
  });

  /** Emits every non-empty final segment (used for auto-answer and dictation). */
  readonly finals$ = new Subject<FinalSegment>();

  /** History id for the current live session; renewed on Clear. */
  sessionId = newId('live');

  private readonly audio = new AudioCapture({
    onPcm: (source, pcm) => this.bridge.api.stt.pushAudio(source, pcm),
    onLevel: (source, level) => this.levels.update((l) => ({ ...l, [source]: level })),
    onEnded: (source) => this.onTrackEnded(source),
  });

  constructor() {
    this.bridge.listen(this.bridge.api.stt.onEvent, (e) => this.onEvent(e));
    void this.bridge.api.stt.status().then((s) => this.status.set(s));
  }

  async start(sources: AudioSource[]): Promise<void> {
    if (this.starting() || this.capture() !== 'idle') return;
    this.error.set(null);
    this.starting.set(true);
    try {
      this.status.set(await this.bridge.api.stt.start({ sessionId: this.sessionId, sources }));
      const failures: string[] = [];
      for (const source of sources) {
        try {
          await this.audio.start(source, this.settings.settings().stt.micDeviceId);
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
      this.activeSources.set(this.audio.sources);
      if (this.audio.sources.length === 0) {
        await this.stop();
      }
      if (failures.length) this.error.set(failures.join('\n'));
    } catch (err) {
      this.error.set(cleanIpcError(err));
      this.audio.stop();
      await this.bridge.api.stt.stop().catch(() => undefined);
    } finally {
      this.starting.set(false);
    }
  }

  async pause(): Promise<void> {
    this.audio.setPaused(true);
    this.status.set(await this.bridge.api.stt.pause());
  }

  async resume(): Promise<void> {
    this.audio.setPaused(false);
    this.status.set(await this.bridge.api.stt.resume());
  }

  async stop(): Promise<void> {
    this.audio.stop();
    this.activeSources.set([]);
    this.status.set(await this.bridge.api.stt.stop());
  }

  /** Start, pause or resume depending on the current state (used by the global shortcut). */
  async toggle(): Promise<void> {
    const c = this.capture();
    if (c === 'recording') return this.pause();
    if (c === 'paused') return this.resume();
    const sources = this.settings.settings().stt.sources;
    const list = (Object.keys(sources) as AudioSource[]).filter((s) => sources[s]);
    return this.start(list.length ? list : ['mic']);
  }

  clear(): void {
    this.segments.set([]);
    this.selected.set(new Set());
    // A cleared transcript starts a new history session once capture is idle.
    if (this.capture() === 'idle') this.sessionId = newId('live');
  }

  toggleSelected(id: string): void {
    this.selected.update((sel) => {
      const next = new Set(sel);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  clearSelection(): void {
    this.selected.set(new Set());
  }

  /** Plain-text transcript, labelled by speaker. */
  asText(): string {
    return this.finals()
      .map((s) => `${s.source === 'mic' ? 'You' : 'Meeting'}: ${s.text}`)
      .join('\n');
  }

  /** The last few finals as context for an AI request. */
  recentContext(maxChars = 2500): string {
    const text = this.asText();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  }

  private onEvent(e: SttEvent): void {
    switch (e.type) {
      case 'status':
        this.status.set(e.status);
        // The main process stopped capture (e.g. the speech engine failed): release devices.
        if (e.status.capture === 'idle' && this.audio.sources.length > 0 && !this.starting()) {
          this.audio.stop();
          this.activeSources.set([]);
        }
        break;
      case 'error':
        this.error.set(e.message);
        break;
      case 'partial':
      case 'final': {
        const partial = e.type === 'partial';
        this.segments.update((list) => {
          const i = list.findIndex((s) => s.id === e.segmentId);
          if (!partial && !e.text) return i >= 0 ? list.filter((_, j) => j !== i) : list;
          const seg: TranscriptSegment = {
            id: e.segmentId,
            source: e.source,
            text: e.text,
            partial,
            at: e.at,
            question: !!e.question,
          };
          if (i >= 0) {
            // A late partial must never overwrite a final.
            if (partial && !list[i].partial) return list;
            const next = list.slice();
            next[i] = seg;
            return next;
          }
          const next = [...list, seg];
          return next.length > MAX_SEGMENTS ? next.slice(-MAX_SEGMENTS) : next;
        });
        if (!partial && e.text) {
          this.finals$.next({ id: e.segmentId, source: e.source, text: e.text, partial: false, at: e.at, question: !!e.question });
        }
        break;
      }
    }
  }

  private onTrackEnded(source: AudioSource): void {
    this.audio.stop(source);
    this.activeSources.set(this.audio.sources);
    this.error.set(`${source === 'mic' ? 'Microphone' : 'System audio'} capture ended (device disconnected or sharing stopped).`);
    if (this.audio.sources.length === 0) void this.stop();
  }
}
