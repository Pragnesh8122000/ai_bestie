/**
 * Gapless playback of synthesized speech through one persistent AudioContext.
 *
 * Why not one <audio> element per chunk (the previous approach): the next
 * chunk could only start from the previous element's `ended` event, so every
 * boundary paid event dispatch + element start-up, and each chunk also built
 * a brand-new AudioContext just to meter its level. Here each decoded chunk is
 * scheduled on the context's clock at the exact sample where the previous one
 * ends, one analyser serves every chunk, and the context is unlocked once by a
 * user gesture — which is also what iOS/Safari require before audio produced
 * later (after a fetch, not inside a click handler) is allowed to play.
 *
 * `speech.ts` owns the queue, sessions and engine choice; this module only
 * knows how to schedule buffers, wait on the audio clock, and stop.
 */

type AudioContextCtor = typeof AudioContext;

// A context whose clock hasn't moved for this long while audio is scheduled
// is treated as stuck (e.g. interrupted on iOS and never resumed), so a
// waiting caller is released instead of freezing speech forever.
const STALL_MS = 4000;
const RESUME_TIMEOUT_MS = 300;

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let scheduledUntil = 0;
const active = new Set<AudioBufferSourceNode>();
const wakers = new Set<() => void>();
let levelListener: ((level: number) => void) | null = null;
let meterFrame = 0;

function ctorOf(): AudioContextCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  );
}

export function isWebAudioSupported(): boolean {
  return !!ctorOf();
}

/** The shared context, created on first use. Null when unsupported. */
export function getAudioContext(): AudioContext | null {
  if (ctx && ctx.state !== 'closed') return ctx;
  const Ctor = ctorOf();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    analyser.connect(ctx.destination);
    scheduledUntil = 0;
    return ctx;
  } catch {
    ctx = null;
    analyser = null;
    return null;
  }
}

/**
 * Call from a user gesture: creates/resumes the context and plays one silent
 * sample, which is what unlocks audio output on iOS Safari for the rest of
 * the page's life.
 */
export function unlockAudio(): void {
  const c = getAudioContext();
  if (!c) return;
  if (c.state !== 'running') void c.resume().catch(() => {});
  try {
    const silent = c.createBuffer(1, 1, c.sampleRate);
    const src = c.createBufferSource();
    src.buffer = silent;
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* unlocking is best-effort */
  }
}

let unlockInstalled = false;
/** Unlock on every user gesture until the context is running (idempotent). */
export function installAudioUnlock(): void {
  if (unlockInstalled || typeof document === 'undefined' || !isWebAudioSupported()) return;
  unlockInstalled = true;
  const onGesture = () => {
    if (!ctx || ctx.state !== 'running') unlockAudio();
  };
  for (const type of ['pointerdown', 'keydown', 'touchend']) {
    document.addEventListener(type, onGesture, { capture: true, passive: true });
  }
}

/** True once the context is running, trying a resume first if needed. */
export async function ensureRunning(): Promise<boolean> {
  const c = getAudioContext();
  if (!c) return false;
  if (c.state === 'running') return true;
  await Promise.race([
    c.resume().catch(() => {}),
    new Promise((r) => setTimeout(r, RESUME_TIMEOUT_MS)),
  ]);
  // Re-read: resume() changes the state asynchronously.
  return (c.state as AudioContextState) === 'running';
}

/** Decode a WAV/MP3/... body. Null when decoding fails or is unsupported. */
export async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer | null> {
  const c = getAudioContext();
  if (!c) return null;
  try {
    return await c.decodeAudioData(data);
  } catch {
    return null;
  }
}

/**
 * Schedule `buffer` to start exactly when previously scheduled audio ends (or
 * immediately if nothing is scheduled). Returns its end time on the context
 * clock.
 */
export function scheduleBuffer(buffer: AudioBuffer): number {
  const c = getAudioContext();
  if (!c || !analyser) return 0;
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(analyser);
  // A few ms of lead so the very first chunk isn't clipped by the render
  // quantum already in flight; later chunks start on the previous end sample.
  const startAt = Math.max(c.currentTime + 0.02, scheduledUntil);
  src.start(startAt);
  scheduledUntil = startAt + buffer.duration;
  active.add(src);
  src.onended = () => {
    active.delete(src);
    try {
      src.disconnect();
    } catch {
      /* already disconnected */
    }
    if (active.size === 0) stopMeter();
  };
  startMeter();
  return scheduledUntil;
}

/** Context time at which everything scheduled so far finishes. */
export function scheduledEnd(): number {
  return scheduledUntil;
}

export function hasScheduledAudio(): boolean {
  return !!ctx && active.size > 0 && ctx.currentTime < scheduledUntil;
}

/**
 * Resolve when the audio clock reaches `time`, when `stopAll()` is called, or
 * when the clock has stalled for STALL_MS (so a suspended/interrupted context
 * can never freeze the caller).
 */
export function waitForTime(time: number): Promise<'reached' | 'stopped' | 'stalled'> {
  return new Promise((resolve) => {
    const c = ctx;
    if (!c) {
      resolve('stopped');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastClock = c.currentTime;
    let lastProgress = Date.now();
    const finish = (result: 'reached' | 'stopped' | 'stalled') => {
      if (timer) clearTimeout(timer);
      wakers.delete(wake);
      resolve(result);
    };
    const wake = () => finish('stopped');
    wakers.add(wake);
    const check = () => {
      const now = c.currentTime;
      if (now >= time) return finish('reached');
      if (now > lastClock) {
        lastClock = now;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > STALL_MS) {
        return finish('stalled');
      } else if (c.state === 'suspended') {
        void c.resume().catch(() => {});
      }
      timer = setTimeout(check, Math.min(250, Math.max(10, (time - now) * 1000)));
    };
    check();
  });
}

/** Stop every scheduled/playing chunk now and release any waiters. */
export function stopAll(): void {
  for (const src of active) {
    try {
      src.onended = null;
      src.stop();
      src.disconnect();
    } catch {
      /* not started yet / already stopped */
    }
  }
  active.clear();
  scheduledUntil = ctx ? ctx.currentTime : 0;
  stopMeter();
  for (const wake of [...wakers]) wake();
}

/** Normalized playback amplitude (0..1) while chunks play; 0 when silent. */
export function setPlaybackLevelListener(fn: ((level: number) => void) | null): void {
  levelListener = fn;
  if (!fn) stopMeter();
  else if (active.size) startMeter();
}

function startMeter(): void {
  if (meterFrame || !levelListener || !analyser || typeof requestAnimationFrame === 'undefined')
    return;
  const values = new Uint8Array(analyser.frequencyBinCount);
  const read = () => {
    if (!analyser || !levelListener || active.size === 0) {
      stopMeter();
      return;
    }
    analyser.getByteFrequencyData(values);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    levelListener(Math.min(1, average / 110));
    meterFrame = requestAnimationFrame(read);
  };
  meterFrame = requestAnimationFrame(read);
}

function stopMeter(): void {
  if (meterFrame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(meterFrame);
  meterFrame = 0;
  levelListener?.(0);
}

/** Test hook: forget the shared context so a fresh fake can be installed. */
export function __resetAudioPlayerForTests(): void {
  stopAll();
  ctx = null;
  analyser = null;
  scheduledUntil = 0;
  unlockInstalled = false;
}
