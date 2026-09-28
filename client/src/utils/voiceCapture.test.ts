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

import { createEndOfSpeechDetector, startVoiceTurn } from './voiceCapture';

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

  it('defaults the turn cap to 20s now that listenOnce restarts across pauses itself', async () => {
    isSTTSupported.mockReturnValue(true);
    listenOnce.mockReturnValue({ promise: Promise.resolve('hi'), stop: vi.fn() });

    await startVoiceTurn().promise;

    expect(listenOnce).toHaveBeenCalledWith('en-US', undefined, 20_000);
  });

  it('forwards an onInterim callback so a barge-in probe can detect speech while TTS plays', async () => {
    isSTTSupported.mockReturnValue(true);
    listenOnce.mockReturnValue({ promise: Promise.resolve('hi'), stop: vi.fn() });
    const onInterim = vi.fn();

    await startVoiceTurn(undefined, 1_000, onInterim).promise;

    expect(listenOnce).toHaveBeenCalledWith('en-US', onInterim, 1_000);
  });

  it('never uploads to the paid transcription endpoint for a silent barge-in probe on Brave network failures', async () => {
    vi.useFakeTimers();
    isSTTSupported.mockReturnValue(true);
    listenOnce.mockReturnValue({
      promise: Promise.reject(new Error('network')),
      stop: vi.fn(),
    });

    const result = startVoiceTurn(undefined, 1_000, undefined, false).promise;
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ transcript: '', usedServerFallback: false });
    expect(transcribeVoiceClip).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('never uploads to the paid transcription endpoint for a silent barge-in probe when STT is unsupported', async () => {
    vi.useFakeTimers();
    isSTTSupported.mockReturnValue(false);

    const result = startVoiceTurn(undefined, 1_000, undefined, false).promise;
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ transcript: '', usedServerFallback: false });
    expect(transcribeVoiceClip).not.toHaveBeenCalled();
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

  it('keeps the fallback recording under the server clip limit even with the 20s turn cap', async () => {
    // The server rejects clips over 12s (413). Recording the full 20s turn
    // made every Brave fallback clip fail.
    vi.useFakeTimers();
    isSTTSupported.mockReturnValue(true);
    listenOnce.mockReturnValue({ promise: Promise.reject(new Error('network')), stop: vi.fn() });

    const result = startVoiceTurn().promise;
    await vi.runAllTimersAsync();
    await result;

    const [, duration] = transcribeVoiceClip.mock.calls[0];
    expect(duration).toBeLessThanOrEqual(12_000);
  });
});

describe('end-of-speech detection for the recorded fallback', () => {
  it('ends the turn after speech followed by a pause', () => {
    const d = createEndOfSpeechDetector();
    let t = 0;
    for (; t < 800; t += 50) expect(d.update(0.3, t)).toBe(false); // talking
    for (; t < 800 + 1150; t += 50) expect(d.update(0.02, t)).toBe(false); // short pause
    expect(d.update(0.02, 800 + 1250)).toBe(true);
  });

  it('never ends a turn before any speech was heard', () => {
    const d = createEndOfSpeechDetector();
    for (let t = 0; t < 5000; t += 50) expect(d.update(0.01, t)).toBe(false);
  });

  it('ignores a click or blip shorter than real speech', () => {
    const d = createEndOfSpeechDetector();
    d.update(0.5, 0);
    d.update(0.5, 100); // 100ms burst
    for (let t = 150; t < 3000; t += 50) expect(d.update(0.01, t)).toBe(false);
  });

  it('keeps listening through a mid-sentence breath', () => {
    const d = createEndOfSpeechDetector();
    let t = 0;
    for (; t < 600; t += 50) d.update(0.3, t);
    for (; t < 1200; t += 50) expect(d.update(0.02, t)).toBe(false); // 600ms breath
    for (; t < 1800; t += 50) expect(d.update(0.3, t)).toBe(false); // talking again
  });
});
