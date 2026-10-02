import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { formatIst, istDay } from './time';

/**
 * Voice-performance metrics: one structured JSON line per event.
 *
 * Only identifiers, sizes, timings and outcome codes belong here — never user
 * speech, message text, reply text or audio. Callers pass lengths (`inputChars`)
 * rather than content, so the log is safe to keep and ship for analysis.
 *
 * Lines always go to stdout (picked up by the host's log capture). When
 * `config.metrics.dir` is set they are also appended to
 * `voice-metrics-YYYY-MM-DD.jsonl` there — one file per Asia/Kolkata day, which is
 * the rotation. `ts` is `yyyy-mm-dd hh-mm-ss` in Asia/Kolkata (see time.ts). A failing file write never affects the request being measured.
 */

/**
 * Client-generated id that ties one voice turn's browser, STT, chat and TTS log
 * lines together. Header values are untrusted, so only a short opaque token
 * (UUID-like) is accepted — content can never be smuggled into the log.
 */
export const VOICE_TURN_HEADER = 'X-Voice-Turn';
export function voiceTurnId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : undefined;
}

export type MetricFields = Record<string, unknown>;
export type MetricSink = (line: string) => void;

let sinkOverride: MetricSink | null = null;
let fileStream: fs.WriteStream | null = null;
let fileDay = '';
let fileDisabled = false;

/** Test hook: capture lines instead of writing them. Pass null to restore. */
export function setMetricSink(sink: MetricSink | null): void {
  sinkOverride = sink;
}

function writeToFile(line: string, now: Date): void {
  const dir = config.metrics.dir;
  if (!dir || fileDisabled) return;
  const day = istDay(now);
  try {
    if (!fileStream || fileDay !== day) {
      fileStream?.end();
      fs.mkdirSync(dir, { recursive: true });
      fileStream = fs.createWriteStream(path.join(dir, `voice-metrics-${day}.jsonl`), {
        flags: 'a',
      });
      fileStream.on('error', () => {
        // Disk full / permissions: stop file logging, keep stdout.
        fileDisabled = true;
        fileStream = null;
      });
      fileDay = day;
    }
    fileStream.write(line + '\n');
  } catch {
    fileDisabled = true;
  }
}

export function logMetric(evt: string, fields: MetricFields = {}): void {
  const now = new Date();
  const line = JSON.stringify({ ts: formatIst(now), evt, ...fields });
  if (sinkOverride) {
    sinkOverride(line);
    return;
  }
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
  console.log(line);
  writeToFile(line, now);
}
