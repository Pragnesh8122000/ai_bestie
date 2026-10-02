/**
 * Voice pipeline timing report: joins the browser's `voice.turn.client` lines
 * with the server's `stt.transcribe` / `chat.turn` / `tts.synth` lines by turnId.
 *
 *   npm run voice-report -w server                 # newest log file, last 5 turns + summary
 *   npm run voice-report -w server -- --last 20
 *   npm run voice-report -w server -- --file path/to/voice-metrics-2026-10-02.jsonl
 *   npm run voice-report -w server -- --json       # joined turns as JSON
 *
 * Production keeps no file by default: set VOICE_METRICS_DIR, or save the host's
 * stdout to a file and pass --file (non-JSON lines are ignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSummary, formatTurn, joinTurns, parseLines } from '../utils/voiceReport.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.VOICE_METRICS_DIR?.trim() || path.resolve(here, '../../logs');

function newestLog(): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^voice-metrics-.*\.jsonl$/.test(f))
    .sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

const file = value('file') ?? newestLog();
if (!file || !fs.existsSync(file)) {
  console.error(`No voice metrics log found (looked in ${dir}). Use --file <path>.`);
  process.exit(1);
}

const turns = joinTurns(parseLines(fs.readFileSync(file, 'utf8')));
if (flag('json')) {
  console.log(JSON.stringify(turns, null, 2));
} else {
  const last = Number(value('last') ?? 5);
  console.log(`# ${file}\n`);
  for (const turn of turns.slice(-last)) console.log(formatTurn(turn) + '\n');
  console.log(formatSummary(turns));
}
