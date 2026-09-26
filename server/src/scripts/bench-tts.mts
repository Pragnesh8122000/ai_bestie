/**
 * Repeatable Kokoro TTS benchmark: real inference + a voice-reply pipeline
 * timeline built from those real inference times.
 *
 *   npm run bench-tts -w server
 *   TTS_NUM_THREADS=2 npm run bench-tts -w server
 *   BENCH_JSON=1 npm run bench-tts -w server        # machine-readable output
 *
 * Part 1 measures the model itself: load time, resident memory, first
 * (cold) vs warm inference, and the real-time factor (RTF = inference time /
 * audio duration) for short, medium and long chunks.
 *
 * Part 2 replays representative replies through the client's real chunkers
 * (legacy one-then-two-sentences rule vs. the current SpeechChunker) as if
 * tokens were streaming from the LLM, synthesizes every chunk with the real
 * model for its exact audio duration, and lays the results on a timeline:
 * one serial inference queue on the server, a fixed network round-trip, and
 * the client's prefetch depth. Inference time per chunk comes from a
 * best-of-3 linear fit measured in Part 1, so a busy machine skews every
 * strategy equally. It reports time to first audio (TTFA) and the silence
 * between chunks. The network/LLM constants are assumptions (see NET_*).
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { OfflineTts, GenerationConfig } = require('sherpa-onnx-node');

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const modelDir =
  process.env.TTS_MODEL_PATH || path.join(repoRoot, 'server/.tts-models/kokoro-multi-lang-v1_0');
const threads = Math.max(1, Number(process.env.TTS_NUM_THREADS || 1));
const SID = Number(process.env.TTS_SID || 3);
const SPEED = Number(process.env.TTS_SPEED || 0.95);
const asJson = process.env.BENCH_JSON === '1';

// Timeline assumptions (not measured here — tune for your deployment).
const LLM_TTFT_MS = 700; // time to first LLM token
const LLM_CHARS_PER_SEC = 250; // streamed reply text rate
const NET_RTT_MS = 80; // browser <-> server round trip per /api/tts call
const NET_BYTES_PER_MS = 2500; // ~20 Mbit/s download for the WAV body
const HTML_AUDIO_START_MS = 40; // new Audio(blob) + play() + per-chunk AudioContext
const WEB_AUDIO_START_MS = 5; // decodeAudioData of a WAV; scheduling is gapless

const out: Record<string, unknown> = { threads, sid: SID, speed: SPEED };
const log = (...a: unknown[]) => {
  if (!asJson) console.log(...a);
};

if (!fs.existsSync(path.join(modelDir, 'model.onnx'))) {
  console.error(`Kokoro model not found at ${modelDir}. Run: npm run download-tts-model -w server`);
  process.exit(2);
}

const rss0 = process.memoryUsage().rss;
let t0 = performance.now();
const lexicon = path.join(modelDir, 'lexicon-us-en.txt');
const tts = await OfflineTts.createAsync({
  model: {
    kokoro: {
      model: path.join(modelDir, 'model.onnx'),
      voices: path.join(modelDir, 'voices.bin'),
      tokens: path.join(modelDir, 'tokens.txt'),
      dataDir: path.join(modelDir, 'espeak-ng-data'),
      ...(fs.existsSync(lexicon) ? { lexicon } : {}),
    },
    debug: false,
    numThreads: threads,
    provider: 'cpu',
  },
});
out.loadMs = Math.round(performance.now() - t0);
out.modelRssMB = Math.round((process.memoryUsage().rss - rss0) / 1e6);
log(`load ${out.loadMs} ms, +${out.modelRssMB} MB RSS, ${threads} thread(s)`);

async function synth(text: string): Promise<{ ms: number; audioMs: number }> {
  const t = performance.now();
  const a = await tts.generateAsync({
    text,
    generationConfig: new GenerationConfig({ sid: SID, speed: SPEED }),
  });
  return { ms: performance.now() - t, audioMs: (a.samples.length / a.sampleRate) * 1000 };
}

/* ----------------------------- Part 1 ----------------------------- */

const sizes: Record<string, string> = {
  short: "Hey, that's great news!",
  medium:
    "I'm really glad you told me that. It sounds like today was a lot, and you still showed up for yourself.",
  long: "Honestly, I think you handled it better than you're giving yourself credit for. You noticed the feeling, you named it, and you didn't let it run the whole evening. That's a skill, and it gets easier every time you practice it. Want to talk through what set it off?",
};

const cold = await synth(sizes.short);
const warm = await synth(sizes.short);
out.coldFirstMs = Math.round(cold.ms);
out.warmSameTextMs = Math.round(warm.ms);
log(`first inference ${out.coldFirstMs} ms vs warm ${out.warmSameTextMs} ms (same text)`);

// Best of 3 per size: a shared dev machine is noisy, and the minimum is the
// closest estimate of what the model itself costs.
const REPS = Number(process.env.BENCH_REPS || 3);
const rtf: Record<string, { words: number; inferMs: number; audioMs: number; rtf: number }> = {};
for (const [k, text] of Object.entries(sizes)) {
  let best = await synth(text);
  for (let i = 1; i < REPS; i++) {
    const r = await synth(text);
    if (r.ms < best.ms) best = r;
  }
  rtf[k] = {
    words: text.split(/\s+/).length,
    inferMs: Math.round(best.ms),
    audioMs: Math.round(best.audioMs),
    rtf: +(best.ms / best.audioMs).toFixed(3),
  };
  log(`${k.padEnd(6)} ${JSON.stringify(rtf[k])}`);
}
out.rtf = rtf;

// Least-squares fit inferMs = fixed + perAudioMs * audioMs over the three
// sizes, used by the timeline so policy comparisons aren't skewed by load.
const pts = Object.values(rtf);
const mx = pts.reduce((a, p) => a + p.audioMs, 0) / pts.length;
const my = pts.reduce((a, p) => a + p.inferMs, 0) / pts.length;
const slope =
  pts.reduce((a, p) => a + (p.audioMs - mx) * (p.inferMs - my), 0) /
  pts.reduce((a, p) => a + (p.audioMs - mx) ** 2, 0);
const fixed = Math.max(0, my - slope * mx);
out.inferenceModel = { fixedMs: Math.round(fixed), perAudioMs: +slope.toFixed(3) };
log(`inference model: ${Math.round(fixed)} ms + ${slope.toFixed(3)} x audio`);

/* ----------------------------- Part 2 ----------------------------- */

const replies: Record<string, string> = {
  ohNo: 'Oh no! That sounds really frustrating. Do you want to vent about it, or would a distraction help more right now?',
  newJob:
    "Hey, I hear you. Starting a new job is a lot, even when it's something you wanted. It's totally normal to feel wobbly for the first couple of weeks. What's been the hardest part so far?",
  proud:
    "That's amazing! I'm so proud of you. You worked really hard for this, and it shows. How are you going to celebrate tonight?",
  tough:
    "Mm, that's a tough one. I think the fact that you're even asking means you already care a lot about getting it right. Maybe start by telling them how you actually feel, without trying to fix anything yet. Would that feel okay?",
  yes: 'Yes.',
  textLong:
    "Honestly, when you're feeling this stretched, the best first step is picking one small thing you can finish today, even if it's tiny, because finishing something gives your brain a quick win. 😊 Here are a few ideas:\n\n- **Clear one surface**, like your desk.\n- Answer the one email you've been dodging.\n- Take a ten minute walk, e.g. around the block.\n\nIf you want more structure, check https://example.com/focus-guide for a simple plan. Then tomorrow we can look at the bigger picture together. Which one feels doable right now?",
};

type Chunker = { push: (t: string) => string[]; flush: () => string[] };

const speechText = (await import('../../../client/src/utils/speechText.ts')) as unknown as {
  stripForSpeech: (md: string) => string;
  takeSpeech: (raw: string, flush?: boolean, min?: number) => { speech: string; rest: string };
};
// The chunker the app ships (absent in builds before 2026-09).
const chunkerModule = (await import('../../../client/src/utils/speechChunker.ts').catch(
  () => ({}),
)) as { SpeechChunker?: new () => Chunker };

/** The pre-2026-09 policy: one sentence first, then two at a time. */
function legacyChunker(): Chunker {
  let buf = '';
  let first = true;
  return {
    push(t) {
      buf += t;
      const { speech, rest } = speechText.takeSpeech(buf, false, first ? 1 : undefined);
      if (!speech) return [];
      buf = rest;
      first = false;
      return [speech];
    },
    flush() {
      const { speech } = speechText.takeSpeech(buf, true);
      buf = '';
      return speech ? [speech] : [];
    },
  };
}

function wholeReplyChunker(): Chunker {
  let buf = '';
  return {
    push: (t) => ((buf += t), []),
    flush: () => [speechText.stripForSpeech(buf)].filter(Boolean),
  };
}

// Produce [{text, readyAt}] by streaming the reply through a chunker.
function chunksOf(reply: string, chunker: Chunker) {
  const res: { text: string; readyAt: number }[] = [];
  const TOKEN = 4;
  for (let i = 0; i < reply.length; i += TOKEN) {
    const at = LLM_TTFT_MS + ((i + TOKEN) / LLM_CHARS_PER_SEC) * 1000;
    for (const text of chunker.push(reply.slice(i, i + TOKEN))) res.push({ text, readyAt: at });
  }
  const end = LLM_TTFT_MS + (reply.length / LLM_CHARS_PER_SEC) * 1000;
  for (const text of chunker.flush()) res.push({ text, readyAt: end });
  return res;
}

interface Timed {
  text: string;
  readyAt: number;
  inferMs: number;
  audioMs: number;
}

/**
 * Lay synthesized chunks on a timeline. `depth` is how many chunks beyond
 * the one playing may be requested (the original client: 1; now: 2).
 */
function timeline(chunks: Timed[], depth: number, startOverheadMs: number) {
  let serverFree = 0;
  const playStart: number[] = [];
  const playEnd: number[] = [];
  for (let k = 0; k < chunks.length; k++) {
    const gate = k - depth >= 0 ? playStart[k - depth] : 0;
    const req = Math.max(chunks[k].readyAt, gate);
    const begin = Math.max(req + NET_RTT_MS / 2, serverFree);
    serverFree = begin + chunks[k].inferMs;
    const bytes = (chunks[k].audioMs / 1000) * 24000 * 2;
    const arrive = serverFree + NET_RTT_MS / 2 + bytes / NET_BYTES_PER_MS;
    const prevEnd = k ? playEnd[k - 1] : 0;
    playStart[k] = Math.max(arrive + startOverheadMs, prevEnd + (k ? startOverheadMs : 0));
    playEnd[k] = playStart[k] + chunks[k].audioMs;
  }
  const gaps = playStart.slice(1).map((s, i) => Math.max(0, s - playEnd[i]));
  return {
    chunkWords: chunks.map((c) => c.text.split(/\s+/).length),
    ttfaMs: Math.round(playStart[0]),
    totalGapMs: Math.round(gaps.reduce((a, b) => a + b, 0)),
    maxGapMs: Math.round(Math.max(0, ...gaps)),
    doneMs: Math.round(playEnd[playEnd.length - 1]),
  };
}

// Real audio duration per chunk text; inference time from the fitted model.
const audioOf = new Map<string, number>();
async function timed(list: { text: string; readyAt: number }[]): Promise<Timed[]> {
  const res: Timed[] = [];
  for (const c of list) {
    if (!audioOf.has(c.text)) audioOf.set(c.text, (await synth(c.text)).audioMs);
    const audioMs = audioOf.get(c.text)!;
    res.push({ ...c, audioMs, inferMs: fixed + slope * audioMs });
  }
  return res;
}

const strategies: Record<string, { chunker: () => Chunker; depth: number; start: number }> = {
  wholeReply: { chunker: wholeReplyChunker, depth: 1, start: HTML_AUDIO_START_MS },
  legacy: { chunker: legacyChunker, depth: 1, start: HTML_AUDIO_START_MS },
  legacyChunksNewPlayback: { chunker: legacyChunker, depth: 2, start: WEB_AUDIO_START_MS },
  ...(chunkerModule.SpeechChunker
    ? {
        current: {
          chunker: () => new chunkerModule.SpeechChunker!(),
          depth: 2,
          start: WEB_AUDIO_START_MS,
        },
      }
    : {}),
};

const pipeline: Record<string, Record<string, ReturnType<typeof timeline>>> = {};
const totals: Record<string, { ttfaMs: number; totalGapMs: number; maxGapMs: number }> = {};
for (const [name, reply] of Object.entries(replies)) {
  pipeline[name] = {};
  log(`\n${name}`);
  for (const [s, cfg] of Object.entries(strategies)) {
    const t = timeline(await timed(chunksOf(reply, cfg.chunker())), cfg.depth, cfg.start);
    pipeline[name][s] = t;
    const tot = (totals[s] ??= { ttfaMs: 0, totalGapMs: 0, maxGapMs: 0 });
    tot.ttfaMs += t.ttfaMs / Object.keys(replies).length;
    tot.totalGapMs += t.totalGapMs / Object.keys(replies).length;
    tot.maxGapMs = Math.max(tot.maxGapMs, t.maxGapMs);
    log(`  ${s.padEnd(24)} ${JSON.stringify(t)}`);
  }
}
for (const t of Object.values(totals)) {
  t.ttfaMs = Math.round(t.ttfaMs);
  t.totalGapMs = Math.round(t.totalGapMs);
}
out.pipeline = pipeline;
out.averages = totals;
log('\naverage over replies (ttfa, total gap per reply, worst single gap):');
for (const [s, t] of Object.entries(totals)) log(`  ${s.padEnd(24)} ${JSON.stringify(t)}`);
out.assumptions = {
  LLM_TTFT_MS,
  LLM_CHARS_PER_SEC,
  NET_RTT_MS,
  NET_BYTES_PER_MS,
  HTML_AUDIO_START_MS,
  WEB_AUDIO_START_MS,
};
out.rssMB = Math.round(process.memoryUsage().rss / 1e6);

if (asJson) console.log(JSON.stringify(out, null, 2));
else log(`\nprocess RSS ${out.rssMB} MB`);
