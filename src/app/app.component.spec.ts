import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { ElectronBridgeService } from './core/electron-bridge.service';
import { SettingsService } from './core/settings.service';
import { FakeApi, createFakeApi } from './testing/fake-api';

describe('AppComponent', () => {
  let fake: FakeApi;

  beforeEach(async () => {
    fake = createFakeApi();
    await TestBed.configureTestingModule({
      imports: [AppComponent],
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
  });

  async function render() {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('shows app info and the toggle shortcut once loaded', async () => {
    const el: HTMLElement = (await render()).nativeElement;
    expect(el.querySelector('.footer')?.textContent).toContain('Ctrl+Shift+Space');
    expect(el.querySelector('.footer')?.textContent).toContain('v1.2.3');
  });

  it('labels the window as practice mode while not capturing', async () => {
    const el: HTMLElement = (await render()).nativeElement;
    expect(el.querySelector('.badge')?.textContent).toContain('Practice mode');
    expect(el.querySelector('.rec')).toBeNull();
  });

  it('shows a REC indicator while capture is active', async () => {
    const fixture = await render();
    fake.emitStt({ type: 'status', status: { engine: 'ready', capture: 'recording', queue: 0 } });
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.rec')?.textContent).toContain('REC');
    expect(el.querySelector('.shell')?.classList).toContain('capturing');
  });

  describe('first-run AI setup banner', () => {
    const banner = async () => ((await render()).nativeElement as HTMLElement).querySelector<HTMLElement>('.setup-banner');

    it('is hidden when local AI is ready', async () => {
      expect(await banner()).toBeNull();
    });

    it('appears when Ollama is not running', async () => {
      fake.setAiStatus({ reachable: false, models: [], activeModel: undefined });
      expect((await banner())?.textContent).toContain('one-time setup');
    });

    it('appears when Ollama has no models', async () => {
      fake.setAiStatus({ models: [], activeModel: undefined });
      expect((await banner())?.textContent).toContain('one-time setup');
    });

    it('appears when Groq has no key', async () => {
      fake.setAiStatus({ provider: 'groq', apiKeySet: false, reachable: false, models: [] });
      expect((await banner())?.textContent).toContain('one-time setup');
    });

    it('appears when Groq rejects the saved key', async () => {
      fake.setAiStatus({ provider: 'groq', apiKeySet: true, keyRejected: true, reachable: false, models: [] });
      expect((await banner())?.textContent).toContain('one-time setup');
    });

    it('stays away when Groq is merely unreachable: that is not a setup problem', async () => {
      fake.setAiStatus({ provider: 'groq', apiKeySet: true, reachable: false, models: [] });
      expect(await banner()).toBeNull();
    });

    it('opens the Settings tab, where the steps are, and then gets out of the way', async () => {
      fake.setAiStatus({ reachable: false, models: [], activeModel: undefined });
      const fixture = await render();
      const el: HTMLElement = fixture.nativeElement;
      el.querySelector<HTMLElement>('.setup-banner')!.click();
      fixture.detectChanges();
      expect(fixture.componentInstance.tab()).toBe('settings');
      expect(el.querySelector('.setup-banner')).toBeNull();
    });

    it('checks Ollama again when the Settings tab opens, so a fresh install is noticed', async () => {
      const fixture = await render();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('app-settings .setup')).toBeNull();

      fake.setAiStatus({ reachable: false, models: [], activeModel: undefined });
      fixture.componentInstance.tab.set('settings');
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(el.querySelector('app-settings .setup')?.textContent).toContain('Step 1 of 2');
      expect(el.querySelector('app-settings .setup a')?.getAttribute('href')).toBe('https://ollama.com/download/windows');

      fake.setAiStatus({ reachable: true, models: [] });
      fixture.componentInstance.tab.set('live');
      fixture.detectChanges();
      fixture.componentInstance.tab.set('settings');
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(el.querySelector('app-settings .setup')?.textContent).toContain('Step 2 of 2');
    });
  });

  it('toggles always-on-top through the bridge', async () => {
    const fixture = await render();
    expect(fixture.componentInstance.windowState().alwaysOnTop).toBeTrue();
    await fixture.componentInstance.togglePin();
    expect(fixture.componentInstance.windowState().alwaysOnTop).toBeFalse();
  });

  it('forwards window control buttons to the bridge', async () => {
    const fixture = await render();
    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.actions button');
    buttons[1].click();
    buttons[2].click();
    buttons[3].click();
    expect(fake.calls).toEqual(['minimize', 'hide', 'close']);
  });

  it('switches tabs from the navigation and with Ctrl+number', async () => {
    const fixture = await render();
    const el: HTMLElement = fixture.nativeElement;
    el.querySelectorAll<HTMLButtonElement>('.tabs button')[1].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.tab()).toBe('chat');
    expect(el.querySelector<HTMLElement>('app-chat')?.hidden).toBeFalse();
    expect(el.querySelector<HTMLElement>('app-live')?.hidden).toBeTrue();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '5', ctrlKey: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.tab()).toBe('settings');
  });

  it('shows the Ollama model in the status strip', async () => {
    const fixture = await render();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.status')?.textContent).toContain('AI: qwen2.5:7b');
  });

  it('answers the last detected question from the global shortcut', async () => {
    const fixture = await render();
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's1', text: 'What is a Java record?', at: 1, question: true });
    fake.emitShortcut('askAi');
    await fixture.whenStable();
    expect(fake.aiRequests.length).toBe(1);
    expect(fake.aiRequests[0]).toEqual(jasmine.objectContaining({ mode: 'answer', input: 'What is a Java record?', kind: 'live' }));
  });

  it('answers the newest question from the shortcut, not the stale text in the question box', async () => {
    const fixture = await render();
    fake.emitStt({ type: 'final', source: 'mic', segmentId: 's1', text: 'What is a Java record?', at: 1_000, question: true });
    fake.emitShortcut('askAi');
    fake.emitStt({ type: 'final', source: 'mic', segmentId: 's2', text: 'What is a sealed class?', at: 60_000, question: true });
    fake.emitShortcut('askAi');
    await fixture.whenStable();
    expect(fake.aiRequests.map((r) => (r as { input: string }).input)).toEqual(['What is a Java record?', 'What is a sealed class?']);
  });

  it('auto-answers the whole question when its end arrives as a separate line', async () => {
    const fixture = await render();
    await TestBed.inject(SettingsService).update({ ai: { autoAnswer: true, answerEveryLine: false } });
    fake.emitStt({ type: 'final', source: 'mic', segmentId: 's1', text: 'Do you ever work on the...', at: 1_000, question: true });
    fake.emitStt({ type: 'final', source: 'mic', segmentId: 's2', text: 'AWS?', at: 2_000, question: false });
    // Questions only: a reply heard afterwards is not merged into the question and does not trigger an answer.
    fake.emitStt({ type: 'final', source: 'mic', segmentId: 's3', text: 'Yes, I have used S3.', at: 4_000, question: false });
    await fixture.whenStable();
    expect(fake.aiRequests.map((r) => (r as { input: string }).input)).toEqual([
      'Do you ever work on the...',
      'Do you ever work on the AWS?',
    ]);
  });

  it('auto-answers a question whose start was misheard as a statement', async () => {
    const fixture = await render();
    await TestBed.inject(SettingsService).update({ ai: { autoAnswer: true } });
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's1', text: 'But I do four pillars of...', at: 1_000, question: false });
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's2', text: 'OOP in Java.', at: 2_000, question: true });
    await fixture.whenStable();
    expect(fake.aiRequests.map((r) => (r as { input: string }).input)).toEqual(['But I do four pillars of OOP in Java.']);
  });

  it('answers a line that is not a question once the speaker pauses', async () => {
    const fixture = await render();
    await TestBed.inject(SettingsService).update({ ai: { autoAnswer: true } });
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's1', text: 'Mm-hmm.', at: 1_000, question: false });
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's2', text: 'And how we use in your project.', at: 2_000, question: false });
    // Not at once: more of the same turn may follow.
    expect(fake.aiRequests.length).toBe(0);
    await fixture.whenStable();
    expect(fake.aiRequests.map((r) => (r as { input: string }).input)).toEqual(['And how we use in your project.']);
  });

  it('answers a follow-up together with the question before it', async () => {
    const fixture = await render();
    await TestBed.inject(SettingsService).update({ ai: { autoAnswer: true } });
    fake.emitStt({ type: 'final', source: 'mic', segmentId: 's1', text: 'So tell me what is the microservices in Java.', at: 1_000, question: true });
    fake.emitStt({ type: 'final', source: 'mic', segmentId: 's2', text: 'And how we use in your project.', at: 9_700, question: false });
    await fixture.whenStable();
    expect(fake.aiRequests.map((r) => (r as { input: string }).input)).toEqual([
      'So tell me what is the microservices in Java.',
      'So tell me what is the microservices in Java. And how we use in your project.',
    ]);
  });

  it('does not answer acknowledgements, and waits for the line still being spoken', async () => {
    const fixture = await render();
    await TestBed.inject(SettingsService).update({ ai: { autoAnswer: true } });
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's1', text: "Okay, that's great, nice.", at: 1_000, question: false });
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's2', text: 'Program using streams.', at: 2_000, question: false });
    fake.emitStt({ type: 'partial', source: 'system', segmentId: 's3', text: 'So you take', at: 3_000 });
    await new Promise((r) => setTimeout(r, 3_000));
    // The partial is still on screen, so the turn is not answered yet.
    expect(fake.aiRequests.length).toBe(0);
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's3', text: 'So you take one list of integers.', at: 4_000, question: false });
    await fixture.whenStable();
    expect(fake.aiRequests.map((r) => (r as { input: string }).input)).toEqual(['Program using streams. So you take one list of integers.']);
  }, 15_000);

  it('answers what was said after the last question instead of repeating that question', async () => {
    const fixture = await render();
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's1', text: 'What is a Java record?', at: 1_000, question: true });
    fake.emitShortcut('askAi');
    // A coding task given in plain sentences, with an acknowledgement in between.
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's2', text: 'Program using streams.', at: 20_000, question: false });
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's3', text: 'Mm-hmm.', at: 21_000, question: false });
    fake.emitStt({ type: 'final', source: 'system', segmentId: 's4', text: 'So you take one list of integers.', at: 30_000, question: false });
    fake.emitShortcut('askAi');
    await fixture.whenStable();
    expect(fake.aiRequests.map((r) => (r as { input: string }).input)).toEqual([
      'What is a Java record?',
      'Program using streams. So you take one list of integers.',
    ]);
  });
});
