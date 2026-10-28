import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FakeApi, createFakeApi } from '../testing/fake-api';
import { ElectronBridgeService } from './electron-bridge.service';
import { FinalSegment, TranscriptService } from './transcript.service';

describe('TranscriptService', () => {
  let fake: FakeApi;
  let service: TranscriptService;

  beforeEach(() => {
    fake = createFakeApi();
    TestBed.configureTestingModule({
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
    });
    service = TestBed.inject(TranscriptService);
  });

  it('replaces a partial with its final and never lets a late partial overwrite it', () => {
    fake.emitStt({ type: 'partial', source: 'mic', segmentId: 'a', text: 'what is', at: 1 });
    expect(service.segments()[0]).toEqual(jasmine.objectContaining({ text: 'what is', partial: true }));
    fake.emitStt({ type: 'final', source: 'mic', segmentId: 'a', text: 'What is Kafka?', at: 2, question: true });
    fake.emitStt({ type: 'partial', source: 'mic', segmentId: 'a', text: 'what is ka', at: 3 });
    expect(service.segments().length).toBe(1);
    expect(service.segments()[0]).toEqual(jasmine.objectContaining({ text: 'What is Kafka?', partial: false, question: true }));
    expect(service.lastQuestion()?.text).toBe('What is Kafka?');
  });

  it('removes a segment whose final turned out empty', () => {
    fake.emitStt({ type: 'partial', source: 'system', segmentId: 'b', text: 'uh', at: 1 });
    fake.emitStt({ type: 'final', source: 'system', segmentId: 'b', text: '', at: 2 });
    expect(service.segments()).toEqual([]);
  });

  it('emits finals on finals$ and builds labelled text and selections', () => {
    const seen: FinalSegment[] = [];
    service.finals$.subscribe((s) => seen.push(s));
    fake.emitStt({ type: 'final', source: 'system', segmentId: 'c', text: 'Tell me about yourself.', at: 1, question: true });
    fake.emitStt({ type: 'final', source: 'mic', segmentId: 'd', text: 'I am a Java developer.', at: 2 });
    expect(seen.map((s) => s.id)).toEqual(['c', 'd']);
    expect(service.asText()).toBe('Meeting: Tell me about yourself.\nYou: I am a Java developer.');

    service.toggleSelected('d');
    service.toggleSelected('c');
    expect(service.selectedText()).toBe('Tell me about yourself. I am a Java developer.');
    service.toggleSelected('c');
    expect(service.selectedText()).toBe('I am a Java developer.');
  });

  it('starts a new history session when cleared while idle', () => {
    const before = service.sessionId;
    fake.emitStt({ type: 'final', source: 'mic', segmentId: 'e', text: 'hello there', at: 1 });
    service.clear();
    expect(service.segments()).toEqual([]);
    expect(service.sessionId).not.toBe(before);
  });

  it('tracks capture status events', () => {
    fake.emitStt({ type: 'status', status: { engine: 'ready', capture: 'paused', queue: 2 } });
    expect(service.capture()).toBe('paused');
    expect(service.recording()).toBeFalse();
  });
});
