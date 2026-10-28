import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AiStream } from '../core/ai.service';
import { ElectronBridgeService } from '../core/electron-bridge.service';
import { FakeApi, createFakeApi } from '../testing/fake-api';
import { ResponseViewComponent } from './response-view.component';

@Component({
  standalone: true,
  imports: [ResponseViewComponent],
  template: `
    <div class="scroller" style="height: 200px; overflow-y: auto; width: 320px">
      <div [style.height.px]="above()"></div>
      <app-response-view [stream]="stream()" (regenerate)="regenerated = regenerated + 1" />
    </div>
  `,
})
class HostComponent {
  readonly stream = signal<AiStream | null>(null);
  readonly above = signal(0);
  regenerated = 0;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const PARAGRAPH = 'Streaming text that wraps over several lines in a narrow panel, like a real answer does.\n\n';

describe('ResponseViewComponent scrolling', () => {
  let fake: FakeApi;
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let scroller: HTMLElement;
  let cancelled: string[];

  beforeEach(async () => {
    fake = createFakeApi();
    cancelled = [];
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: ElectronBridgeService, useValue: { api: fake.api, isElectron: true } }],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    scroller = fixture.nativeElement.querySelector('.scroller');
  });

  /** Start a new stream and let the view settle, as after pressing an Ask button. */
  async function startStream(): Promise<AiStream> {
    const s = new AiStream({ mode: 'answer', input: 'q' }, (id) => cancelled.push(id));
    s.requestId = 'req-1';
    host.stream.set(s);
    await render();
    s.apply({ requestId: 'req-1', type: 'start', model: 'test-model' });
    await render();
    return s;
  }

  async function render(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    await nextFrame();
  }

  async function chunk(s: AiStream, text = PARAGRAPH): Promise<void> {
    s.apply({ requestId: 'req-1', type: 'chunk', text });
    await render();
  }

  it('stays at the top while the answer streams, instead of following new text', async () => {
    const s = await startStream();
    for (let i = 0; i < 30; i++) {
      await chunk(s);
      expect(scroller.scrollTop).withContext(`after chunk ${i}`).toBe(0);
    }
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight * 3);
    expect(s.state()).toBe('streaming');

    s.apply({ requestId: 'req-1', type: 'done', text: s.text(), durationMs: 1200 });
    await render();
    expect(scroller.scrollTop).toBe(0);
    expect(fixture.nativeElement.querySelector('.md').textContent).toContain('Streaming text');
  });

  it('keeps any position the reader scrolls to, and generation carries on', async () => {
    const s = await startStream();
    for (let i = 0; i < 20; i++) await chunk(s);

    scroller.scrollTop = 150;
    const lengthBefore = s.text().length;
    for (let i = 0; i < 10; i++) {
      await chunk(s);
      expect(scroller.scrollTop).toBe(150);
    }

    // Scrolling to the current end does not make the view follow later text either.
    scroller.scrollTop = scroller.scrollHeight;
    const end = scroller.scrollTop;
    for (let i = 0; i < 10; i++) await chunk(s);
    expect(scroller.scrollTop).toBe(end);
    expect(scroller.scrollHeight - scroller.clientHeight).toBeGreaterThan(end + 100);

    // Scrolling back up works too.
    scroller.scrollTop = 0;
    await chunk(s);
    expect(scroller.scrollTop).toBe(0);

    expect(s.text().length).toBeGreaterThan(lengthBefore);
    expect(s.state()).toBe('streaming');
    expect(cancelled).toEqual([]);
  });

  it('brings the start of a new answer into view once, then leaves scrolling to the reader', async () => {
    host.above.set(600);
    fixture.detectChanges();
    const s = await startStream();

    const view = fixture.nativeElement.querySelector('app-response-view') as HTMLElement;
    const offset = view.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(20);

    const revealed = scroller.scrollTop;
    for (let i = 0; i < 15; i++) {
      await chunk(s);
      expect(scroller.scrollTop).toBe(revealed);
    }

    // Scrolling away is respected for the rest of this answer.
    scroller.scrollTop = 0;
    for (let i = 0; i < 5; i++) await chunk(s);
    expect(scroller.scrollTop).toBe(0);
  });

  it('does not scroll when the new answer already starts in view', async () => {
    host.above.set(40);
    fixture.detectChanges();
    await startStream();
    expect(scroller.scrollTop).toBe(0);
  });

  it('keeps Markdown, code blocks and the Stop, Copy, Regenerate and Retry actions working', async () => {
    const el = fixture.nativeElement as HTMLElement;
    const s = await startStream();
    await chunk(s, 'Use a **HashMap**:\n\n```java\nMap<String, Integer> m = new HashMap<>();\n');
    expect(el.querySelector('.md strong')?.textContent).toBe('HashMap');
    expect(el.querySelector('.md .code code')?.textContent).toContain('new HashMap<>()');

    const button = (label: string) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('app-response-view button')).find((b) => b.textContent?.trim() === label);
    expect(button('Stop')).toBeDefined();

    s.apply({ requestId: 'req-1', type: 'done', text: s.text() + '```\n', durationMs: 900 });
    await render();
    expect(button('Stop')).toBeUndefined();
    button('Copy')!.click();
    await fixture.whenStable();
    expect(fake.calls.some((c) => c.startsWith('copy:Use a **HashMap**'))).toBeTrue();
    button('Regenerate')!.click();
    expect(host.regenerated).toBe(1);

    // Stop cancels the request.
    const second = new AiStream({ mode: 'answer', input: 'q2' }, (id) => cancelled.push(id));
    second.requestId = 'req-2';
    host.stream.set(second);
    await render();
    button('Stop')!.click();
    await render();
    expect(cancelled).toEqual(['req-2']);
    expect(el.querySelector('app-response-view .meta')?.textContent).toContain('Stopped');

    // Errors show Retry, which asks the parent to run the request again.
    const failed = new AiStream({ mode: 'answer', input: 'q3' }, () => undefined);
    host.stream.set(failed);
    failed.apply({ requestId: 'x', type: 'error', code: 'unreachable', message: 'Cannot reach Ollama' });
    await render();
    expect(el.querySelector('.error-box')?.textContent).toContain('Cannot reach Ollama');
    button('Retry')!.click();
    expect(host.regenerated).toBe(2);
  });
});
