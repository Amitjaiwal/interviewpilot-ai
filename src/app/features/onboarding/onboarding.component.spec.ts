import { NgZone } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { AiStatus } from '../../../../shared/ipc';
import { NEW_INSTALL_SETTINGS } from '../../../../shared/settings';
import { AppComponent } from '../../app.component';
import { ElectronBridgeService } from '../../core/electron-bridge.service';
import { FakeApi, createFakeApi } from '../../testing/fake-api';

describe('First-run setup', () => {
  let fake: FakeApi;
  let fixture: ComponentFixture<AppComponent>;

  const noKey: Partial<AiStatus> = { provider: 'groq', apiKeySet: false, reachable: false, models: [], activeModel: undefined, version: undefined };
  const connected: Partial<AiStatus> = { provider: 'groq', apiKeySet: true, reachable: true, keyRejected: false, error: undefined, models: [{ name: 'm', sizeBytes: 0 }], activeModel: 'm' };

  const el = (): HTMLElement => fixture.nativeElement;
  const text = () => el().querySelector('app-onboarding')?.textContent ?? '';

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function press(label: string): Promise<void> {
    const button = Array.from(el().querySelectorAll<HTMLElement>('app-onboarding button, app-onboarding .choice')).find((b) => b.textContent?.includes(label));
    if (!button) throw new Error(`No "${label}" in: ${text()}`);
    button.click();
    await settle();
  }

  async function enterKey(key: string): Promise<void> {
    const input = el().querySelector<HTMLInputElement>('app-onboarding input[type=password]')!;
    input.value = key;
    input.dispatchEvent(new Event('input'));
    await settle();
    await press('Save and test');
  }

  beforeEach(async () => {
    // Test machines may have no audio devices at all.
    spyOn(navigator.mediaDevices, 'enumerateDevices').and.resolveTo([{ kind: 'audioinput', deviceId: '', label: '' } as MediaDeviceInfo]);
    fake = createFakeApi();
    fake.setSettings(NEW_INSTALL_SETTINGS);
    fake.setAiStatus(noKey);
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
    fixture = TestBed.createComponent(AppComponent);
    await settle();
  });

  afterEach(() => TestBed.resetTestingModule());

  it('replaces the main view on a new installation', () => {
    expect(text()).toContain('Welcome to InterviewPilot AI');
    expect(el().querySelector('.tabs')).toBeNull();
    expect(el().querySelector('app-live')).toBeNull();
    expect(el().querySelector('.footer kbd')?.textContent).toContain('Ctrl+Shift+Space');
  });

  it('never appears for an existing user', async () => {
    fake.setSettings({ ...NEW_INSTALL_SETTINGS, setup: { onboardingDone: true } });
    TestBed.resetTestingModule();
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
    fixture = TestBed.createComponent(AppComponent);
    await settle();
    expect(el().querySelector('app-onboarding')).toBeNull();
    expect(el().querySelector('.tabs')).not.toBeNull();
  });

  it('recommends Groq and selects it by default, and explains what is sent to it', async () => {
    await press('Get started');
    expect(text()).toContain('Recommended');
    expect(el().querySelector('.choice.on')?.textContent).toContain('Groq Cloud AI');
    expect(text()).toContain('sent to Groq');
    expect(text()).toContain('audio stays on this PC');
  });

  it('walks through the whole setup with a valid key', async () => {
    fake.onSetApiKey(() => ({ ...noKey, ...connected }) as AiStatus);
    await press('Get started');
    await press('Continue');
    expect(text()).toContain('Connect to Groq');
    expect(el().querySelector('app-onboarding a')?.getAttribute('href')).toBe('https://console.groq.com/keys');
    expect(el().querySelectorAll('app-onboarding .how-to li').length).toBe(3);
    expect(text()).toContain('Create API Key');
    expect(text()).toContain('Ctrl+V');
    expect(text()).toContain("Don't share it with anyone");
    expect(text()).toContain('Skip for now');

    await enterKey('  gsk_some_key_for_this_test_only  ');
    expect(text()).toContain('Connected to Groq');
    expect(el().querySelector('app-onboarding input[type=password]')).toBeNull();

    await press('Continue');
    expect(text()).toContain('Speech engine is ready');
    expect(text()).toContain('Microphone found');

    await press('Continue');
    expect(text()).toContain("You're all set");
    expect(text()).toContain('Groq Cloud AI is ready');
    expect(text()).toContain('Ctrl+Shift+Space');

    await press('Start using InterviewPilot AI');
    expect(fake.settings.setup.onboardingDone).toBeTrue();
    expect(el().querySelector('app-onboarding')).toBeNull();
    expect(el().querySelector('.tabs')).not.toBeNull();
  });

  it('trims the key before saving it, and clears the field afterwards', async () => {
    const saved: string[] = [];
    fake.onSetApiKey((key) => {
      saved.push(key);
      return { ...noKey, ...connected } as AiStatus;
    });
    await press('Get started');
    await press('Continue');
    await enterKey('  gsk_some_key_for_this_test_only  ');
    expect(saved).toEqual(['gsk_some_key_for_this_test_only']);
    expect(fixture.debugElement.query((d) => d.name === 'app-onboarding').componentInstance.keyDraft).toBe('');
  });

  it('shows why a key was rejected and stays on the step', async () => {
    fake.onSetApiKey(() => {
      throw new Error("Error invoking remote method 'ai:set-api-key': Error: Groq rejected this key.");
    });
    await press('Get started');
    await press('Continue');
    await enterKey('gsk_some_key_for_this_test_only');
    expect(el().querySelector('app-onboarding .error-box')?.textContent).toContain('Groq rejected this key.');
    expect(el().querySelector('app-onboarding input[type=password]')).not.toBeNull();
    expect(text()).toContain('Skip for now');
    expect(Array.from(el().querySelectorAll('app-onboarding .actions button')).some((b) => b.textContent?.includes('Continue'))).toBeFalse();
  });

  it('keeps an untestable key with a warning, and can continue offline', async () => {
    fake.onSetApiKey(() => ({ ...noKey, apiKeySet: true, error: 'Cannot reach Groq. Check your internet connection. (getaddrinfo ENOTFOUND api.groq.com)' }) as AiStatus);
    await press('Get started');
    await press('Continue');
    await enterKey('gsk_some_key_for_this_test_only');
    expect(el().querySelector('app-onboarding .warn-box')?.textContent).toContain('could not be tested');
    expect(el().querySelector('app-onboarding .warn-box')?.textContent).toContain('Check your internet connection');
    expect(el().querySelector('app-onboarding .warn-box')?.textContent).not.toContain('ENOTFOUND');
    await press('Continue');
    await press('Continue');
    expect(text()).toContain("You're all set");
    expect(text()).toContain("will be tested once you're online");
  });

  it('can be skipped without a key, which the last step points out', async () => {
    await press('Get started');
    await press('Continue');
    await press('Skip for now');
    await press('Continue');
    expect(text()).toContain('Almost there');
    expect(text()).toContain("AI answers aren't set up yet");
    await press('Start using InterviewPilot AI');
    expect(fake.settings.setup.onboardingDone).toBeTrue();
    expect(fake.settings.ai.provider).toBe('groq');
    expect(el().querySelector('.setup-banner')?.textContent).toContain('one-time setup');
  });

  it('can be skipped entirely from the first step', async () => {
    await press('Skip setup');
    expect(fake.settings.setup.onboardingDone).toBeTrue();
    expect(el().querySelector('.tabs')).not.toBeNull();
  });

  it('saves the choice of Ollama and shows how to install it when missing', async () => {
    await press('Get started');
    await press('Ollama Local AI');
    fake.setAiStatus({ provider: 'local', reachable: false, installed: false, models: [], activeModel: undefined });
    await press('Continue');
    expect(fake.settings.ai.provider).toBe('local');
    expect(text()).toContain('Step 1 of 2: install Ollama');
    expect(el().querySelector('app-onboarding .setup a')?.getAttribute('href')).toBe('https://ollama.com/download/windows');
    expect(text()).toContain('Skip for now');
  });

  it('tells Ollama not running apart from not installed', async () => {
    await press('Get started');
    await press('Ollama Local AI');
    fake.setAiStatus({ provider: 'local', reachable: false, installed: true, models: [], activeModel: undefined });
    await press('Continue');
    expect(text()).toContain('Step 1 of 2: start Ollama');
    expect(text()).toContain('installed but not running');
    expect(el().querySelector('app-onboarding .setup a')).toBeNull();
  });

  it('moves on when Ollama is ready, and lets people return to Groq', async () => {
    await press('Get started');
    await press('Ollama Local AI');
    fake.setAiStatus({ provider: 'local', reachable: true, models: [{ name: 'qwen2.5:7b', sizeBytes: 1 }], activeModel: 'qwen2.5:7b' });
    await press('Continue');
    expect(text()).toContain('Ollama is ready');

    await press('Back');
    await press('Groq Cloud AI');
    fake.setAiStatus(noKey);
    await press('Continue');
    expect(fake.settings.ai.provider).toBe('groq');
    expect(text()).toContain('Connect to Groq');
  });

  it('reports a speech engine that does not start, can retry it, and does not block setup', async () => {
    fake.api.stt.test = async () => ({ engine: 'error', capture: 'idle', queue: 0, error: 'Speech engine failed to start' });
    await press('Get started');
    await press('Continue');
    await press('Skip for now');
    expect(el().querySelector('app-onboarding .error-box')?.textContent).toContain('Speech engine failed to start');

    fake.api.stt.test = async () => ({ engine: 'ready', capture: 'idle', queue: 0 });
    await press('Try again');
    expect(text()).toContain('Speech engine is ready');
    await press('Continue');
    expect(text()).toContain('Speech recognition is ready');
  });

  it('warns when Windows blocks the microphone', async () => {
    fake.api.stt.micAccess = async () => 'denied';
    await press('Get started');
    await press('Continue');
    await press('Skip for now');
    expect(el().querySelector('app-onboarding .warn-box')?.textContent).toContain('Windows is blocking the microphone');
  });
});
