import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Regression tests for the "multiple voices in one reply" bug.
 *
 * Two independent causes, both covered here:
 *   1. Every chunk independently fell back to the browser voice on error, so a
 *      single failed /api/tts request mid-reply switched voices mid-thought.
 *   2. The browser fallback picked `en[0]` when no name matched, which is a
 *      male voice on several platforms and differs per machine.
 */

type SpokenVoice = { engine: 'remote' | 'local'; voice: string };
let spoken: SpokenVoice[] = [];

class FakeVoice {
  constructor(
    public name: string,
    public lang: string,
    public localService = true,
  ) {}
}

// --- speechSynthesis fake ------------------------------------------------
let installedVoices: FakeVoice[] = [];
const synthCancel = vi.fn();

class FakeUtterance {
  voice: FakeVoice | null = null;
  lang = '';
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

function installSpeechSynthesis() {
  (globalThis as any).SpeechSynthesisUtterance = FakeUtterance;
  (globalThis as any).speechSynthesis = {
    getVoices: () => installedVoices,
    cancel: synthCancel,
    onvoiceschanged: null,
    speak: (u: FakeUtterance) => {
      spoken.push({ engine: 'local', voice: u.voice ? u.voice.name : '<default>' });
      // Speak asynchronously like the real API.
      setTimeout(() => u.onend?.(), 0);
    },
  };
  (globalThis as any).window = globalThis;
}

// --- Audio / blob-URL fakes ----------------------------------------------
class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  preload = '';
  src: string;
  constructor(url: string) {
    this.src = url;
  }
  play() {
    spoken.push({ engine: 'remote', voice: 'kokoro' });
    setTimeout(() => this.onended?.(), 0);
    return Promise.resolve();
  }
  pause() {}
}

function flush(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

let speech: typeof import('./speech');

async function loadFreshModule() {
  vi.resetModules();
  spoken = [];
  speech = await import('./speech');
}

beforeEach(() => {
  installedVoices = [
    new FakeVoice('Daniel', 'en-GB'), // male, deliberately first
    new FakeVoice('Samantha', 'en-US'),
  ];
  installSpeechSynthesis();
  (globalThis as any).Audio = FakeAudio;
  (globalThis as any).URL.createObjectURL = () => 'blob:fake';
  (globalThis as any).URL.revokeObjectURL = () => {};
  synthCancel.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('voice consistency', () => {
  it('uses the neural voice for every chunk when the server is healthy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => ({ size: 1024 }) })),
    );
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    speech.speakChunk('Three.');
    await flush(120);

    expect(spoken.length).toBe(3);
    expect(new Set(spoken.map((s) => s.engine))).toEqual(new Set(['remote']));
  });

  it('does NOT switch to the browser voice when one chunk fails mid-reply', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        // Second chunk fails, exactly like a transient 503/network blip.
        if (call === 2) throw new Error('network');
        return { ok: true, blob: async () => ({ size: 1024 }) };
      }),
    );
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    speech.speakChunk('Three.');
    await flush(150);

    // The failed chunk is skipped, not spoken by a second voice.
    const engines = new Set(spoken.map((s) => s.engine));
    expect(engines.has('local')).toBe(false);
    expect(engines).toEqual(new Set(['remote']));
  });

  it('uses one consistent browser voice when the server is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, blob: async () => ({ size: 0 }) })),
    );
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    speech.speakChunk('Three.');
    await flush(150);

    expect(spoken.length).toBe(3);
    const voices = new Set(spoken.map((s) => s.voice));
    expect(voices.size).toBe(1);
    // Female voice chosen over the male 'Daniel' that appears first in the list.
    expect([...voices][0]).toBe('Samantha');
  });

  it('never picks a male voice even when no known female voice exists', async () => {
    installedVoices = [new FakeVoice('Daniel', 'en-GB'), new FakeVoice('Google UK English Female', 'en-GB')];
    installSpeechSynthesis();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('Hello there.');
    await flush(80);

    expect(spoken.map((s) => s.voice)).toEqual(['Google UK English Female']);
  });

  it('stays on the browser voice once locked, even if the server recovers', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        if (call === 1) throw new Error('offline'); // locks to local
        return { ok: true, blob: async () => ({ size: 1024 }) };
      }),
    );
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    await flush(60);
    speech.speakChunk('Two.');
    await flush(60);

    expect(new Set(spoken.map((s) => s.engine))).toEqual(new Set(['local']));
  });

  it('treats an empty audio body as a failure rather than silent playback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => ({ size: 0 }) })),
    );
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    await flush(80);

    // Falls back to the single browser voice instead of playing nothing.
    expect(spoken).toEqual([{ engine: 'local', voice: 'Samantha' }]);
  });
});

describe('playback serialisation', () => {
  it('does not swap to a better voice when onvoiceschanged fires mid-reply', async () => {
    // Chrome populates getVoices() asynchronously and fires onvoiceschanged
    // after playback may already have begun. Re-picking then would change the
    // voice mid-reply — exactly the bug this module prevents.
    installedVoices = [new FakeVoice('Zira', 'en-US')]; // low-ranked female
    installSpeechSynthesis();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline'); // force the browser-voice path
      }),
    );
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('First.');
    await flush(40);

    // A higher-ranked voice shows up part-way through the reply.
    installedVoices = [new FakeVoice('Zira', 'en-US'), new FakeVoice('Samantha', 'en-US')];
    (globalThis as any).speechSynthesis.onvoiceschanged?.();

    speech.speakChunk('Second.');
    await flush(60);
    speech.speakChunk('Third.');
    await flush(60);

    expect(spoken.length).toBe(3);
    expect(new Set(spoken.map((s) => s.voice)).size).toBe(1);
  });

  it('still picks the female voice when the list fills in before any speech', async () => {
    // The freeze must not stop the *initial* async population from being used.
    installedVoices = [];
    installSpeechSynthesis();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await loadFreshModule(); // imported with zero voices available

    installedVoices = [new FakeVoice('Daniel', 'en-GB'), new FakeVoice('Samantha', 'en-US')];
    (globalThis as any).speechSynthesis.onvoiceschanged?.();

    speech.beginSpeech();
    speech.speakChunk('Hello.');
    await flush(60);

    expect(spoken.map((s) => s.voice)).toEqual(['Samantha']);
  });

  it('plays chunks one at a time, in order, with no overlap', async () => {
    const active: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    class SlowAudio extends FakeAudio {
      play() {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        active.push(concurrent);
        setTimeout(() => {
          concurrent--;
          this.onended?.();
        }, 20);
        return Promise.resolve();
      }
    }
    (globalThis as any).Audio = SlowAudio;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => ({ size: 1024 }) })),
    );
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    speech.speakChunk('Three.');
    await flush(250);

    expect(maxConcurrent).toBe(1);
    expect(active.length).toBe(3);
  });

  it('stopSpeaking() halts playback and reports not-speaking', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => ({ size: 1024 }) })),
    );
    await loadFreshModule();

    const states: boolean[] = [];
    speech.setTtsStateListener((s) => states.push(s));

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    await flush(10);
    speech.stopSpeaking();
    const countAtStop = spoken.length;
    await flush(120);

    expect(states[states.length - 1]).toBe(false);
    // No further audio started after the stop.
    expect(spoken.length).toBe(countAtStop);
  });
});

/**
 * The companion used to pause 3-5s at every full stop. The pump was fully
 * serial (fetch, play, fetch, play), so each sentence boundary stalled for the
 * whole synthesis time of the next chunk — measured at 2.2-3.2s against the
 * real Kokoro endpoint.
 *
 * Synthesis now overlaps playback. These tests pin that behaviour without
 * weakening the ordering and cancellation guarantees above.
 */
describe('inter-sentence gap', () => {
  // Each test here drives real timers. Without an explicit teardown the
  // previous test's queue keeps draining into the *next* test's shared
  // `spoken` array, so assertions see phantom playbacks.
  afterEach(async () => {
    speech?.stopSpeaking?.();
    await flush(60);
  });

  /** Audio that plays for `playMs`, and synthesis that takes `synthMs`. */
  function installTimedTts(synthMs: number, playMs: number) {
    const events: Array<{ at: number; kind: string; n: number }> = [];
    const t0 = Date.now();
    let fetchN = 0;
    let playN = 0;

    class TimedAudio extends FakeAudio {
      play() {
        const n = ++playN;
        events.push({ at: Date.now() - t0, kind: 'play-start', n });
        spoken.push({ engine: 'remote', voice: 'kokoro' });
        setTimeout(() => {
          events.push({ at: Date.now() - t0, kind: 'play-end', n });
          this.onended?.();
        }, playMs);
        return Promise.resolve();
      }
    }
    (globalThis as any).Audio = TimedAudio;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const n = ++fetchN;
        events.push({ at: Date.now() - t0, kind: 'fetch-start', n });
        await new Promise((r) => setTimeout(r, synthMs));
        events.push({ at: Date.now() - t0, kind: 'fetch-end', n });
        return { ok: true, blob: async () => ({ size: 1024 }) };
      }),
    );
    return events;
  }

  /** Silence between the end of one chunk and the start of the next. */
  function gaps(events: Array<{ at: number; kind: string; n: number }>): number[] {
    const out: number[] = [];
    const starts = events.filter((e) => e.kind === 'play-start');
    const ends = events.filter((e) => e.kind === 'play-end');
    for (let i = 0; i < ends.length; i++) {
      const next = starts.find((s) => s.n === ends[i].n + 1);
      if (next) out.push(next.at - ends[i].at);
    }
    return out;
  }

  it('synthesizes the next chunk while the current one is playing', async () => {
    const events = installTimedTts(60, 100);
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    speech.speakChunk('Three.');
    await flush(700);

    // The decisive assertion: chunk 2's synthesis begins before chunk 1's
    // audio ends. Under the old serial pump it began strictly after.
    const fetch2 = events.find((e) => e.kind === 'fetch-start' && e.n === 2)!;
    const play1End = events.find((e) => e.kind === 'play-end' && e.n === 1)!;
    expect(fetch2).toBeDefined();
    expect(fetch2.at).toBeLessThan(play1End.at);
  });

  it('leaves almost no silence between sentences when synthesis is faster than playback', async () => {
    // Mirrors production: synthesis ~0.6x the audio duration.
    const events = installTimedTts(60, 100);
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    speech.speakChunk('Three.');
    await flush(700);

    const g = gaps(events);
    expect(g.length).toBe(2);
    // Prefetched audio is already in hand, so the swap is near-instant. The
    // old behaviour left a full synthesis (60ms here) of dead air.
    for (const gap of g) expect(gap).toBeLessThan(30);
  });

  it('still bounds the gap when synthesis is slower than playback', async () => {
    // Worst case: synthesis outruns the audio it produces. The gap cannot be
    // zero, but it must be the *overhang* (synth - play), not the full synth.
    const events = installTimedTts(150, 100);
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    await flush(900);

    const g = gaps(events);
    expect(g.length).toBe(1);
    // Serial would have been ~150ms; overlapped leaves ~50ms.
    expect(g[0]).toBeLessThan(110);
  });

  it('keeps sentences in order and non-overlapping while prefetching', async () => {
    const events = installTimedTts(30, 80);
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    speech.speakChunk('Three.');
    speech.speakChunk('Four.');
    await flush(900);

    const order = events.filter((e) => e.kind.startsWith('play')).map((e) => `${e.kind}:${e.n}`);
    // Strictly start,end,start,end... — never two overlapping utterances.
    expect(order).toEqual([
      'play-start:1', 'play-end:1',
      'play-start:2', 'play-end:2',
      'play-start:3', 'play-end:3',
      'play-start:4', 'play-end:4',
    ]);
  });

  it('does not prefetch more than one chunk ahead', async () => {
    // The server synthesizes under a mutex, so deeper queuing buys nothing and
    // wastes CPU on audio a stop would discard.
    const events = installTimedTts(40, 200);
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    speech.speakChunk('Three.');
    speech.speakChunk('Four.');
    await flush(150); // chunk 1 still playing

    const started = events.filter((e) => e.kind === 'fetch-start').length;
    expect(started).toBeLessThanOrEqual(2);
  });

  it('discards a prefetched chunk when speech is stopped', async () => {
    // Distinct blob URLs so a *specific* one can be traced. Counting total
    // revokes is not enough: normal playback revokes its own URL, so a naive
    // "something was revoked" assertion passes even when the prefetched chunk
    // leaks (verified by deleting the cleanup line — the test still passed).
    let issued = 0;
    const created: string[] = [];
    const revoked: string[] = [];
    (globalThis as any).URL.createObjectURL = () => {
      const u = `blob:chunk-${++issued}`;
      created.push(u);
      return u;
    };
    installTimedTts(30, 200);
    await loadFreshModule();
    (globalThis as any).URL.revokeObjectURL = (u: string) => revoked.push(u);

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    await flush(120); // chunk 1 playing, chunk 2 prefetched and waiting
    const countAtStop = spoken.length;
    expect(created.length).toBe(2); // the prefetch really did happen
    speech.stopSpeaking();
    await flush(300);

    // The prefetched chunk never plays...
    expect(spoken.length).toBe(countAtStop);
    // ...and *its* blob URL specifically is released, not just chunk 1's.
    expect(revoked).toContain(created[1]);
  });

  it('still falls back to one browser voice when the very first chunk fails', async () => {
    // Prefetch must not let a concurrent request decide the engine: the first
    // chunk is always synthesized alone, so ttsMode is pinned race-free.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    speech.speakChunk('Three.');
    await flush(200);

    expect(spoken.length).toBe(3);
    expect(new Set(spoken.map((s) => s.engine))).toEqual(new Set(['local']));
    expect(new Set(spoken.map((s) => s.voice)).size).toBe(1);
  });

  it('skips a failed middle chunk without switching voices or stalling', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        await new Promise((r) => setTimeout(r, 20));
        if (call === 2) throw new Error('network');
        return { ok: true, blob: async () => ({ size: 1024 }) };
      }),
    );
    await loadFreshModule();

    speech.beginSpeech();
    speech.speakChunk('One.');
    speech.speakChunk('Two.');
    speech.speakChunk('Three.');
    await flush(400);

    // Two of three play; the failure is silent, not a second voice, and the
    // queue keeps draining rather than deadlocking on the rejected prefetch.
    expect(spoken.length).toBe(2);
    expect(new Set(spoken.map((s) => s.engine))).toEqual(new Set(['remote']));
  });
});

/**
 * Regression tests for the Brave/Safari voice-typing divergence.
 *
 * Brave ships the `webkitSpeechRecognition` constructor (it's Chromium), so
 * `isSTTSupported()` is true there just like Chrome and Safari — the failure
 * shows up only once `.start()` runs, as an `onerror` event with
 * `error: 'network'`, because Brave disables the Google backend that powers
 * the API. These tests fake that constructor directly so both the
 * Brave-like (network error) and Safari-like (working) paths are covered
 * without needing a real browser.
 */
describe('speech-to-text', () => {
  class FakeRecognition {
    lang = '';
    continuous = false;
    interimResults = false;
    onresult: ((e: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean; length: number }> }) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    stopped = false;
    start() {
      this.started = true;
    }
    stop() {
      this.stopped = true;
      // Real engines fire onend once stop() completes.
      queueMicrotask(() => this.onend?.());
    }
  }

  function result(transcript: string, isFinal: boolean) {
    return { 0: { transcript }, isFinal, length: 1 };
  }

  afterEach(() => {
    delete (globalThis as any).SpeechRecognition;
    delete (globalThis as any).webkitSpeechRecognition;
  });

  it('reports unsupported when neither constructor exists', async () => {
    await loadFreshModule();
    expect(speech.isSTTSupported()).toBe(false);
  });

  it('reports supported via webkitSpeechRecognition, same as Brave and Safari expose it', async () => {
    (globalThis as any).webkitSpeechRecognition = FakeRecognition;
    await loadFreshModule();
    expect(speech.isSTTSupported()).toBe(true);
  });

  it('resolves with the final transcript on the Safari-like working path', async () => {
    let instance!: FakeRecognition;
    (globalThis as any).webkitSpeechRecognition = class extends FakeRecognition {
      constructor() {
        super();
        instance = this;
      }
    };
    await loadFreshModule();

    const interim: string[] = [];
    const session = speech.listenOnce('en-US', (t) => interim.push(t));
    instance.onresult?.({ results: [result('hello world', true)] });
    instance.onend?.();

    await expect(session.promise).resolves.toBe('hello world');
  });

  it('surfaces interim results while listening before the final one arrives', async () => {
    let instance!: FakeRecognition;
    (globalThis as any).webkitSpeechRecognition = class extends FakeRecognition {
      constructor() {
        super();
        instance = this;
      }
    };
    await loadFreshModule();

    const interim: string[] = [];
    const session = speech.listenOnce('en-US', (t) => interim.push(t));
    instance.onresult?.({ results: [result('hel', false)] });
    instance.onresult?.({ results: [result('hello', true)] });
    instance.onend?.();

    expect(interim).toEqual(['hel', 'hello']);
    await expect(session.promise).resolves.toBe('hello');
  });

  it('rejects with "network" on the Brave-like path (constructor present, backend blocked)', async () => {
    let instance!: FakeRecognition;
    (globalThis as any).SpeechRecognition = class extends FakeRecognition {
      constructor() {
        super();
        instance = this;
      }
    };
    await loadFreshModule();

    const session = speech.listenOnce('en-US');
    instance.onerror?.({ error: 'network' });

    await expect(session.promise).rejects.toThrow('network');
  });

  it('rejects with "not-allowed" when mic permission is denied', async () => {
    let instance!: FakeRecognition;
    (globalThis as any).webkitSpeechRecognition = class extends FakeRecognition {
      constructor() {
        super();
        instance = this;
      }
    };
    await loadFreshModule();

    const session = speech.listenOnce('en-US');
    instance.onerror?.({ error: 'not-allowed' });

    await expect(session.promise).rejects.toThrow('not-allowed');
  });

  it('rejects with "audio-capture" when no microphone device is available', async () => {
    let instance!: FakeRecognition;
    (globalThis as any).webkitSpeechRecognition = class extends FakeRecognition {
      constructor() {
        super();
        instance = this;
      }
    };
    await loadFreshModule();

    const session = speech.listenOnce('en-US');
    instance.onerror?.({ error: 'audio-capture' });

    await expect(session.promise).rejects.toThrow('audio-capture');
  });

  it('rejects immediately when no recognition constructor exists at all', async () => {
    await loadFreshModule();
    const session = speech.listenOnce('en-US');
    await expect(session.promise).rejects.toThrow('not supported');
    expect(session.stop).toBeTypeOf('function');
    // Calling stop() on the unsupported no-op session must not throw.
    expect(() => session.stop()).not.toThrow();
  });

  it('stop() ends the session with whatever was transcribed so far, without rejecting', async () => {
    let instance!: FakeRecognition;
    (globalThis as any).webkitSpeechRecognition = class extends FakeRecognition {
      constructor() {
        super();
        instance = this;
      }
    };
    await loadFreshModule();

    const session = speech.listenOnce('en-US');
    instance.onresult?.({ results: [result('partial', true)] });
    session.stop();
    await flush(10);

    expect(instance.stopped).toBe(true);
    await expect(session.promise).resolves.toBe('partial');
  });

  it('auto-stops after maxMs so the mic can never get stuck listening forever', async () => {
    vi.useFakeTimers();
    let instance!: FakeRecognition;
    (globalThis as any).webkitSpeechRecognition = class extends FakeRecognition {
      constructor() {
        super();
        instance = this;
      }
      stop() {
        this.stopped = true;
        this.onend?.();
      }
    };
    await loadFreshModule();

    const session = speech.listenOnce('en-US', undefined, 8000);
    vi.advanceTimersByTime(8000);

    expect(instance.stopped).toBe(true);
    await expect(session.promise).resolves.toBe('');
    vi.useRealTimers();
  });
});
