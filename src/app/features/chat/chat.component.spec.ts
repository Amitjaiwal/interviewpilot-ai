import { Component, NgZone } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { AiRequest } from '../../../../shared/ipc';
import { ElectronBridgeService } from '../../core/electron-bridge.service';
import { FakeApi, createFakeApi } from '../../testing/fake-api';
import { ChatComponent } from './chat.component';

@Component({
  standalone: true,
  imports: [ChatComponent],
  template: `<div style="height: 360px; width: 360px; display: flex; flex-direction: column"><app-chat /></div>`,
})
class HostComponent {}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const LINE = 'A streamed sentence that wraps over a couple of lines in this narrow chat panel.\n\n';

describe('ChatComponent scrolling', () => {
  let fake: FakeApi;
  let fixture: ComponentFixture<HostComponent>;
  let chat: ChatComponent;
  let el: HTMLElement;
  let scroller: HTMLElement;

  beforeEach(async () => {
    fake = createFakeApi();
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        {
          provide: ElectronBridgeService,
          useFactory: (zone: NgZone) => ({
            api: fake.api,
            isElectron: true,
            listen: <T>(sub: (l: (p: T) => void) => () => void, l: (p: T) => void) => sub((p) => zone.run(() => l(p))),
          }),
          deps: [NgZone],
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    el = fixture.nativeElement;
    chat = fixture.debugElement.query(By.directive(ChatComponent)).componentInstance as ChatComponent;
    scroller = el.querySelector('app-chat .panel-body') as HTMLElement;
  });

  async function render(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    await nextFrame();
    fixture.detectChanges();
  }

  /** Send a message; returns the request id the fake backend assigned. */
  async function send(text: string): Promise<string> {
    chat.send(text);
    await render();
    return `req-${fake.aiRequests.length}`;
  }

  async function stream(requestId: string, chunks: number): Promise<void> {
    for (let i = 0; i < chunks; i++) {
      fake.emitAi({ requestId, type: 'chunk', text: LINE });
      await render();
    }
  }

  async function finish(requestId: string): Promise<void> {
    const text = chat.stream()?.text() ?? '';
    fake.emitAi({ requestId, type: 'done', text, durationMs: 500 });
    await render();
  }

  const latestOffset = () =>
    (el.querySelector('app-chat .latest') as HTMLElement).getBoundingClientRect().top - scroller.getBoundingClientRect().top;

  it('puts the new question at the top and keeps the answer still while it streams and finishes', async () => {
    const first = await send('First question');
    fake.emitAi({ requestId: first, type: 'start', model: 'test-model' });
    await stream(first, 12);
    await finish(first);

    const second = await send('Second question');
    fake.emitAi({ requestId: second, type: 'start', model: 'test-model' });
    await render();
    // The new question starts at the top of the panel; earlier messages are above it.
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(latestOffset()).toBeGreaterThanOrEqual(0);
    expect(latestOffset()).toBeLessThan(20);

    const position = scroller.scrollTop;
    const view = el.querySelector('app-chat .latest app-response-view');
    await stream(second, 25);
    expect(scroller.scrollTop).toBe(position);
    expect(scroller.scrollHeight - scroller.clientHeight).toBeGreaterThan(position + 200);

    await finish(second);
    expect(scroller.scrollTop).toBe(position);
    // The finished answer is not swapped for another element while it is being read.
    expect(el.querySelector('app-chat .latest app-response-view')).toBe(view);
    expect(el.querySelector('app-chat .latest .md')?.textContent).toContain('A streamed sentence');
  });

  it('keeps the reader\'s own scroll position while generation continues', async () => {
    const id = await send('Explain Kafka partitions');
    fake.emitAi({ requestId: id, type: 'start', model: 'test-model' });
    await stream(id, 15);

    scroller.scrollTop = 120;
    const before = chat.stream()!.text().length;
    await stream(id, 10);
    expect(scroller.scrollTop).toBe(120);
    expect(chat.stream()!.text().length).toBeGreaterThan(before);
    expect(chat.stream()!.state()).toBe('streaming');
    expect(fake.calls.filter((c) => c.startsWith('cancel:'))).toEqual([]);
  });

  it('adds a finished answer to the conversation history on the next message, and Regenerate replaces it', async () => {
    const first = await send('What is a record?');
    fake.emitAi({ requestId: first, type: 'start', model: 'test-model' });
    fake.emitAi({ requestId: first, type: 'chunk', text: 'An immutable data carrier.' });
    await finish(first);

    // Regenerate re-asks the same question with the same history.
    const regenerate = Array.from(el.querySelectorAll<HTMLButtonElement>('app-chat button')).find(
      (b) => b.textContent?.trim() === 'Regenerate',
    );
    regenerate!.click();
    await render();
    const again = fake.aiRequests[1] as AiRequest;
    expect(again.input).toBe('What is a record?');
    expect(again.messages).toEqual([]);
    expect(chat.turns().map((t) => t.content)).toEqual(['What is a record?']);

    fake.emitAi({ requestId: 'req-2', type: 'chunk', text: 'A final class with accessors.' });
    await finish('req-2');
    await send('Can records extend classes?');
    const next = fake.aiRequests[2] as AiRequest;
    expect(next.messages).toEqual([
      { role: 'user', content: 'What is a record?' },
      { role: 'assistant', content: 'A final class with accessors.' },
    ]);
    expect(el.querySelectorAll('app-chat .msg.user').length).toBe(2);
  });
});
