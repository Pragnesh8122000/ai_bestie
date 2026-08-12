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
