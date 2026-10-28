import type { AudioSource } from '../../../shared/settings';

export interface CaptureCallbacks {
  onPcm(source: AudioSource, pcm: ArrayBuffer): void;
  onLevel(source: AudioSource, level: number): void;
  /** A track ended on its own, e.g. the microphone was unplugged. */
  onEnded(source: AudioSource): void;
}

interface Pipeline {
  stream: MediaStream;
  context: AudioContext;
  node: AudioWorkletNode;
}

const WORKLET_URL = 'audio/pcm-capture-worklet.js';

/**
 * Captures one or more audio sources and streams 16 kHz PCM to callbacks.
 *
 * - mic:    getUserMedia (the main process grants it only while capture is active)
 * - system: getDisplayMedia; the main process answers with Windows loopback
 *           audio. The accompanying screen video track is stopped immediately.
 */
export class AudioCapture {
  private readonly pipelines = new Map<AudioSource, Pipeline>();
  private paused = false;

  constructor(private readonly callbacks: CaptureCallbacks) {}

  get sources(): AudioSource[] {
    return [...this.pipelines.keys()];
  }

  async start(source: AudioSource, micDeviceId = ''): Promise<void> {
    if (this.pipelines.has(source)) return;
    const stream = source === 'mic' ? await openMic(micDeviceId) : await openSystemAudio();
    try {
      const context = new AudioContext();
      await context.audioWorklet.addModule(WORKLET_URL);
      const input = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'pcm-capture', { numberOfOutputs: 0 });
      node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
        if (this.paused) return;
        this.callbacks.onLevel(source, e.data.level);
        this.callbacks.onPcm(source, e.data.pcm);
      };
      input.connect(node);
      if (context.state === 'suspended') await context.resume();
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', () => this.callbacks.onEnded(source));
      }
      this.pipelines.set(source, { stream, context, node });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }
  }

  /** Paused sources keep their devices open but send nothing. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    for (const { stream } of this.pipelines.values()) {
      stream.getAudioTracks().forEach((t) => (t.enabled = !paused));
    }
    if (paused) for (const source of this.pipelines.keys()) this.callbacks.onLevel(source, 0);
  }

  stop(source?: AudioSource): void {
    for (const [s, p] of this.pipelines) {
      if (source && s !== source) continue;
      p.node.port.onmessage = null;
      p.node.disconnect();
      p.stream.getTracks().forEach((t) => t.stop());
      void p.context.close();
      this.pipelines.delete(s);
      this.callbacks.onLevel(s, 0);
    }
    if (this.pipelines.size === 0) this.paused = false;
  }
}

async function openMic(deviceId: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    throw new Error(describeMediaError('microphone', err));
  }
}

async function openSystemAudio(): Promise<MediaStream> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  } catch (err) {
    throw new Error(describeMediaError('system audio', err));
  }
  // Chromium requires a video track for loopback audio; we never use it.
  stream.getVideoTracks().forEach((t) => {
    t.stop();
    stream.removeTrack(t);
  });
  if (stream.getAudioTracks().length === 0) {
    throw new Error('System audio is not available on this device (no loopback track was provided).');
  }
  return stream;
}

function describeMediaError(what: string, err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
      return `Access to the ${what} was denied. Check Windows Settings > Privacy & security > Microphone, and that capture consent is given in Settings.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${what} device was found. Connect one or pick another device in Settings.`;
    case 'NotReadableError':
      return `The ${what} is in use by another application or blocked by the system.`;
    default:
      return `Could not open the ${what}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** List microphones. Labels are only filled in after microphone permission was granted once. */
export async function listMicrophones(): Promise<{ deviceId: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}
