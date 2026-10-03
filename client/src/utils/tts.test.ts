import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reliability of the voice-reply queue: gapless Web Audio scheduling,
 * cancellation (Stop / new message / superseded reply), timeouts, retries,
 * watchdogs, and routing of scripts the English server voice can't speak. The Web Audio clock is
 * faked on top of real timers so scheduling can be asserted exactly.
 */

let spoken: string[] = [];

class FakeUtterance {
  voice: { name: string; lang: string } | null = null;
  lang = '';
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

let voices: Array<{ name: string; lang: string; localService: boolean }> = [];
let utteranceEnds = true;

function installBrowserVoice() {
  (globalThis as any).window = globalThis;
  (globalThis as any).SpeechSynthesisUtterance = FakeUtterance;
  (globalThis as any).speechSynthesis = {
    getVoices: () => voices,
    cancel: vi.fn(),
    onvoiceschanged: null,
    speak: (u: FakeUtterance) => {
      spoken.push(`local:${u.voice?.name ?? 'default'}:${u.text}`);
      if (utteranceEnds) setTimeout(() => u.onend?.(), 5);
    },
  };
}

/* ---------------------------- Web Audio fake ---------------------------- */

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startAt = -1;
  stopped = false;
  constructor(private ctx: FakeAudioContext) {}
  connect() {}
  disconnect() {}
  start(at: number) {
    this.startAt = at;
    this.ctx.started.push(this);
  }
  stop() {
    this.stopped = true;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'running' | 'suspended' | 'closed' = 'running';
  sampleRate = 48000;
  destination = {};
  started: FakeSource[] = [];
  frozen = false;
  private t0 = Date.now();
  private frozenAt = 0;
  private ticker: ReturnType<typeof setInterval>;
  constructor() {
    FakeAudioContext.instances.push(this);
    // Fire `onended` when the clock passes a source's end, like the real thing.
    this.ticker = setInterval(() => {
      for (const s of this.started) {
        if (!s.stopped && s.buffer && this.currentTime >= s.startAt + s.buffer.duration) {
          s.stopped = true;
          s.onended?.();
        }
      }
    }, 2);
  }
  get currentTime() {
    return this.frozen ? this.frozenAt : (Date.now() - this.t0) / 1000;
  }
  freeze() {
    this.frozenAt = this.currentTime;
    this.frozen = true;
  }
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 4,
      connect() {},
      disconnect() {},
      getByteFrequencyData() {},
    };
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate };
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  // The test encodes each chunk's duration in its byte length: 1 byte = 1ms.
  decodeAudioData(data: ArrayBuffer) {
    return Promise.resolve({ duration: data.byteLength / 1000 });
  }
  resume() {
    if (this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }
  close() {
    clearInterval(this.ticker);
    this.state = 'closed';
    return Promise.resolve();
  }
}

/* ------------------------------ helpers ------------------------------ */

type FetchInit = { body: string; signal: AbortSignal; headers: Record<string, string> };
const requests: Array<{ text: string; signal: AbortSignal; headers: Record<string, string> }> = [];

function wavResponse(ms: number) {
  return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(ms) };
}

/** fetch that answers each chunk after `synthMs` with `audioMs` of audio. */
function installTts(synthMs: number, audioMs: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: FetchInit) => {
      requests.push({
        text: JSON.parse(init.body).text,
        signal: init.signal,
        headers: init.headers,
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, synthMs);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      return wavResponse(audioMs);
    }),
  );
}

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tts: typeof import('./tts');
async function load(withWebAudio: boolean) {
  vi.resetModules();
  if (withWebAudio) (globalThis as any).AudioContext = FakeAudioContext;
  else delete (globalThis as any).AudioContext;
  tts = await import('./tts');
}

beforeEach(() => {
  spoken = [];
  requests.length = 0;
  voices = [{ name: 'Samantha', lang: 'en-US', localService: true }];
  utteranceEnds = true;
  FakeAudioContext.instances = [];
  installBrowserVoice();
  (globalThis as any).URL.createObjectURL = () => 'blob:x';
  (globalThis as any).URL.revokeObjectURL = () => {};
});

afterEach(async () => {
  vi.useRealTimers();
  tts?.stopSpeaking();
  await flush(20);
  for (const c of FakeAudioContext.instances) void c.close();
  vi.unstubAllGlobals();
});

describe('gapless Web Audio playback', () => {
  it('schedules each chunk on the exact sample where the previous one ends', async () => {
    installTts(20, 120);
    await load(true);

    tts.beginSpeech();
    tts.speakChunk('One.');
    tts.speakChunk('Two.');
    tts.speakChunk('Three.');
    await flush(600);

    const [ctx] = FakeAudioContext.instances;
    const starts = ctx.started.filter((s) => s.buffer!.duration > 0.01);
    expect(starts.length).toBe(3);
    for (let i = 1; i < starts.length; i++) {
      const prevEnd = starts[i - 1].startAt + starts[i - 1].buffer!.duration;
      expect(starts[i].startAt).toBeCloseTo(prevEnd, 6);
    }
  });

  it('reports speaking while scheduled audio plays and idle once it has finished', async () => {
    installTts(10, 80);
    await load(true);
    const states: boolean[] = [];
    tts.setTtsStateListener((s) => states.push(s));

    tts.beginSpeech();
    tts.speakChunk('One.');
    await flush(40);
    expect(states).toEqual([true]);
    await flush(150);
    expect(states).toEqual([true, false]);
  });

  it('marks first audio exactly when playback starts, once per reply', async () => {
    installTts(10, 80);
    await load(true);
    const onFirstAudio = vi.fn();

    tts.beginSpeech(onFirstAudio);
    tts.speakChunk('One.');
    tts.speakChunk('Two.');
    expect(onFirstAudio).not.toHaveBeenCalled();
    await flush(60);

    expect(onFirstAudio).toHaveBeenCalledTimes(1);
    await flush(180);
    expect(onFirstAudio).toHaveBeenCalledTimes(1);
  });

  it('keeps playing a chunk that arrives while the last one is finishing', async () => {
    installTts(10, 100);
    await load(true);

    tts.beginSpeech();
    tts.speakChunk('One.');
    await flush(60); // chunk 1 is playing; the queue is otherwise empty
    tts.speakChunk('Two.');
    await flush(250);

    const [ctx] = FakeAudioContext.instances;
    expect(ctx.started.filter((s) => s.buffer!.duration > 0.01).length).toBe(2);
  });

  it('releases a waiting reply when the audio clock stalls instead of freezing', async () => {
    installTts(5, 200);
    await load(true);
    const states: boolean[] = [];
    tts.setTtsStateListener((s) => states.push(s));

    tts.beginSpeech();
    tts.speakChunk('One.');
    await flush(30);
    FakeAudioContext.instances[0].freeze(); // e.g. iOS interrupted the context
    await flush(4600);

    expect(states[states.length - 1]).toBe(false);
  }, 10_000);
});

describe('cancellation', () => {
  it('stopSpeaking() aborts in-flight synthesis requests and stops scheduled audio', async () => {
    installTts(80, 300);
    await load(true);

    tts.beginSpeech();
    tts.speakChunk('One.');
    tts.speakChunk('Two.');
    tts.speakChunk('Three.');
    await flush(120); // chunk 1 scheduled, 2 and 3 in flight
    tts.stopSpeaking();

    const [ctx] = FakeAudioContext.instances;
    expect(ctx.started.every((s) => s.stopped)).toBe(true);
    expect(requests.slice(1).every((r) => r.signal.aborted)).toBe(true);
    await flush(200);
    expect(ctx.started.filter((s) => !s.stopped).length).toBe(0);
  });

  it('a new reply never plays late audio from the one it replaced', async () => {
    installTts(60, 100);
    await load(true);

    tts.beginSpeech();
    tts.speakChunk('Old reply.');
    await flush(20); // old request still synthesizing
    tts.beginSpeech(); // user sent another message
    tts.speakChunk('New reply.');
    await flush(300);

    expect(requests.map((r) => r.text)).toEqual(['Old reply.', 'New reply.']);
    expect(requests[0].signal.aborted).toBe(true);
    const [ctx] = FakeAudioContext.instances;
    expect(ctx.started.filter((s) => s.buffer!.duration > 0.01).length).toBe(1);
  });

  it('rapid consecutive replies leave only the last one audible', async () => {
    installTts(30, 60);
    await load(true);

    for (const reply of ['A.', 'B.', 'C.', 'D.']) {
      tts.beginSpeech();
      tts.speakChunk(reply);
      await flush(5);
    }
    await flush(300);

    const [ctx] = FakeAudioContext.instances;
    const played = ctx.started.filter((s) => s.buffer!.duration > 0.01 && s.startAt >= 0);
    expect(played.length).toBe(1);
    expect(requests.slice(0, 3).every((r) => r.signal.aborted)).toBe(true);
  });

  it('tags requests with generation and chunk ids for server logs, never with extra content', async () => {
    installTts(5, 30);
    await load(true);

    tts.beginSpeech();
    tts.speakChunk('One.');
    tts.speakChunk('Two.');
    await flush(150);

    expect(requests[0].headers['X-TTS-Generation']).toMatch(/^\d+$/);
    expect(requests.map((r) => r.headers['X-TTS-Chunk'])).toEqual(['1', '2']);
  });
});

describe('timeouts, retries and watchdogs', () => {
  it('abandons a request that never answers and falls back to the browser voice', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: FetchInit) =>
          new Promise((_resolve, reject) => {
            requests.push({ text: 'x', signal: init.signal, headers: init.headers });
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    await load(false);

    tts.beginSpeech();
    tts.speakChunk('Hello there.');
    await vi.advanceTimersByTimeAsync(35_000);
    await vi.advanceTimersByTimeAsync(100);

    expect(requests[0].signal.aborted).toBe(true);
    expect(spoken).toEqual(['local:Samantha:Hello there.']);
  });

  it('retries once after a real network error, then plays', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (++call === 1) throw new TypeError('Failed to fetch');
        return wavResponse(30);
      }),
    );
    await load(true);

    tts.beginSpeech();
    tts.speakChunk('One.');
    await flush(500);

    expect(call).toBe(2);
    expect(spoken).toEqual([]); // no browser-voice fallback
    expect(FakeAudioContext.instances[0].started.length).toBeGreaterThan(0);
  });

  it('retries a busy 503 that carries Retry-After, but not a plain failure', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        if (call === 1)
          return { ok: false, status: 503, headers: new Headers({ 'Retry-After': '0' }) };
        return wavResponse(30);
      }),
    );
    await load(true);

    tts.beginSpeech();
    tts.speakChunk('One.');
    await flush(300);
    expect(call).toBe(2);
    expect(spoken).toEqual([]);
  });

  it('does not retry a request that was cancelled', async () => {
    installTts(50, 50);
    await load(true);

    tts.beginSpeech();
    tts.speakChunk('One.');
    await flush(10);
    tts.stopSpeaking();
    await flush(200);

    expect(requests.length).toBe(1);
  });

  it('moves on when an <audio> element never fires ended', async () => {
    class SilentAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      preload = '';
      constructor(public src: string) {}
      play() {
        spoken.push('remote');
        return Promise.resolve(); // ...and never ends
      }
      pause() {}
    }
    (globalThis as any).Audio = SilentAudio;
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => ({ size: 44 + 24000 * 2 }) })), // 1s
    );
    await load(false);

    tts.beginSpeech();
    tts.speakChunk('One.');
    tts.speakChunk('Two.');
    await vi.advanceTimersByTimeAsync(100);
    expect(spoken).toEqual(['remote']);
    await vi.advanceTimersByTimeAsync(6_100); // 1s audio + 5s grace
    expect(spoken).toEqual(['remote', 'remote']);
  });

  it('moves on when a browser utterance never fires onend (Chrome ~15s cutoff)', async () => {
    utteranceEnds = false;
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await load(false);

    tts.beginSpeech();
    tts.speakChunk('One.');
    tts.speakChunk('Two.');
    await vi.advanceTimersByTimeAsync(100);
    expect(spoken.length).toBe(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(spoken.length).toBe(2);
  });

  it('splits long browser-voice text into utterances under Chrome’s cutoff', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await load(false);
    const sentence = 'This sentence is here to make the reply long enough to matter. ';

    tts.beginSpeech();
    tts.speakChunk(sentence.repeat(5));
    await flush(120);

    expect(spoken.length).toBeGreaterThan(1);
    for (const s of spoken) expect(s.length - 'local:Samantha:'.length).toBeLessThanOrEqual(200);
  });
});

describe('languages the server voice cannot speak', () => {
  it('speaks a Hindi-script chunk with a Hindi device voice instead of the English neural voice', async () => {
    voices = [
      { name: 'Samantha', lang: 'en-US', localService: true },
      { name: 'Lekha', lang: 'hi-IN', localService: true },
    ];
    installTts(5, 30);
    await load(true);

    tts.beginSpeech();
    tts.speakChunk('मुझे बहुत अच्छा लगा।');
    await flush(100);

    expect(spoken).toEqual(['local:Lekha:मुझे बहुत अच्छा लगा।']);
    expect(requests.length).toBe(0);
  });

  it('keeps using the neural voice for Hindi script when the device has no Hindi voice', async () => {
    installTts(5, 30);
    await load(true);

    tts.beginSpeech();
    tts.speakChunk('मुझे बहुत अच्छा लगा।');
    await flush(100);

    expect(requests.length).toBe(1);
  });
});
