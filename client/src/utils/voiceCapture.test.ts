// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listenOnce = vi.fn();
const isSTTSupported = vi.fn();
const transcribeVoiceClip = vi.fn();

vi.mock('./speech', () => ({
  listenOnce: (...args: unknown[]) => listenOnce(...args),
  isSTTSupported: () => isSTTSupported(),
}));
vi.mock('../api/transcription', () => ({
  transcribeVoiceClip: (...args: unknown[]) => transcribeVoiceClip(...args),
}));

import { startVoiceTurn } from './voiceCapture';

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  state: RecordingState = 'inactive';
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  private stopListeners: Array<() => void> = [];

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || 'audio/webm';
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) } as BlobEvent);
    this.stopListeners.splice(0).forEach((listener) => listener());
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type !== 'stop') return;
    this.stopListeners.push(() => {
      if (typeof listener === 'function') listener(new Event('stop'));
      else listener.handleEvent(new Event('stop'));
    });
  }
}

describe('voice turn capture', () => {
  const stopTrack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    transcribeVoiceClip.mockResolvedValue({ text: 'server transcript' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses working browser recognition without uploading audio', async () => {
    isSTTSupported.mockReturnValue(true);
    listenOnce.mockReturnValue({ promise: Promise.resolve('browser transcript'), stop: vi.fn() });

    await expect(startVoiceTurn().promise).resolves.toEqual({
      transcript: 'browser transcript',
      usedServerFallback: false,
    });
    expect(transcribeVoiceClip).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('falls back to bounded server transcription for Brave network failures', async () => {
    vi.useFakeTimers();
    isSTTSupported.mockReturnValue(true);
    listenOnce.mockReturnValue({
      promise: Promise.reject(new Error('network')),
      stop: vi.fn(),
    });

    const result = startVoiceTurn(undefined, 1_000).promise;
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({
      transcript: 'server transcript',
      usedServerFallback: true,
    });
    expect(transcribeVoiceClip).toHaveBeenCalledTimes(1);
    const [blob, duration] = transcribeVoiceClip.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    expect(duration).toBeLessThanOrEqual(1_100);
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('stops microphone resources and avoids upload when voice mode exits', async () => {
    let finishRecognition: (value: string) => void = () => {};
    isSTTSupported.mockReturnValue(true);
    const recognitionStop = vi.fn(() => finishRecognition(''));
    listenOnce.mockReturnValue({
      promise: new Promise<string>((resolve) => {
        finishRecognition = resolve;
      }),
      stop: recognitionStop,
    });

    const session = startVoiceTurn();
    await Promise.resolve();
    await Promise.resolve();
    session.stop();

    await expect(session.promise).resolves.toEqual({ transcript: '', usedServerFallback: false });
    expect(recognitionStop).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(transcribeVoiceClip).not.toHaveBeenCalled();
  });
});
