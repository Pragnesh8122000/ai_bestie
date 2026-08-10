/**
 * One-time download of the Kokoro English TTS model for sherpa-onnx.
 *
 *   npm run download-tts-model -w server
 *
 * Fetches `kokoro-en-v0_19.tar.bz2` (~330 MB) from the k2-fsa GitHub release
 * and extracts it into `server/.tts-models/kokoro-en-v0_19/`. Idempotent: if
 * the model files are already present, it exits without re-downloading.
 *
 * The model is gitignored — it is never committed. Extraction shells out to
 * `tar` (present on macOS/Linux). Run this on the build host before starting
 * the server, or locally before `npm run dev` if you want neural voice.
 */
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2';
const ARCHIVE_NAME = 'kokoro-en-v0_19.tar.bz2';

// Resolve to <repo>/server/.tts-models whether run via tsx (src/scripts) or
// compiled (dist/scripts) — both are 3 levels below the repo root.
const repoRoot = path.resolve(__dirname, '../../..');
const targetDir = path.join(repoRoot, 'server', '.tts-models');
const modelDir = path.join(targetDir, 'kokoro-en-v0_19');

function modelReady(): boolean {
  return (
    existsSync(path.join(modelDir, 'model.onnx')) &&
    existsSync(path.join(modelDir, 'voices.bin')) &&
    existsSync(path.join(modelDir, 'tokens.txt')) &&
    existsSync(path.join(modelDir, 'espeak-ng-data'))
  );
}

async function download(): Promise<void> {
  if (modelReady()) {
    console.log(`TTS model already present at ${modelDir}`);
    return;
  }

  mkdirSync(targetDir, { recursive: true });
  const archive = path.join(targetDir, ARCHIVE_NAME);

  console.log(`Downloading ${URL}`);
  console.log('(~330 MB — this may take a few minutes on the first run)');
  const res = await fetch(URL);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const ws = createWriteStream(archive);
  const reader = res.body.getReader();
  let received = 0;
  let lastReport = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    ws.write(Buffer.from(value));
    if (received - lastReport > 20 * 1024 * 1024) {
      lastReport = received;
      process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(0)} MB downloaded`);
    }
  }
  ws.end();
  await new Promise<void>((resolve, reject) => {
    ws.on('finish', () => resolve());
    ws.on('error', reject);
  });
  process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(0)} MB downloaded\n`);

  console.log('Extracting archive...');
  const result = spawnSync('tar', ['xf', archive, '-C', targetDir], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`tar extraction failed (exit ${result.status})`);
  }

  unlinkSync(archive);

  if (!modelReady()) {
    throw new Error(
      `Extraction finished but expected files are missing under ${modelDir}. ` +
        'Check the archive contents (kokoro-en-v0_19/ should contain model.onnx, voices.bin, tokens.txt, espeak-ng-data/).',
    );
  }
  console.log(`\nTTS model ready at ${modelDir}`);
  console.log('Voice replies will use neural TTS on next server start.');
}

download().catch((err) => {
  console.error('\nFailed to download TTS model:', err.message || err);
  process.exit(1);
});