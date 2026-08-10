#!/usr/bin/env node
/**
 * Launcher: sets the dynamic-linker search path so the `sherpa-onnx-node`
 * native addon can find its prebuilt platform shared libraries, then runs the
 * given command. The linker reads LD_LIBRARY_PATH / DYLD_LIBRARY_PATH *before*
 * the Node process starts, so it can't be set from inside the app — it must be
 * set on the spawned child's environment, which is what this does.
 *
 * Usage: `node scripts/with-tts-env.cjs <command> [args...]`
 *   e.g. `node scripts/with-tts-env.cjs tsx watch src/server.ts`
 *        `node scripts/with-tts-env.cjs node dist/server.js`
 *
 * Harmless if the platform package is absent (e.g. sherpa-onnx not installed
 * yet, or the addon resolves its libs via rpath): it simply won't prepend a
 * path and runs the command as-is.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkg = `sherpa-onnx-${process.platform}-${process.arch}`;
// npm workspaces may hoist platform deps to the repo root or keep them under
// the workspace; check both.
const candidates = [
  path.resolve(__dirname, 'node_modules', pkg),
  path.resolve(__dirname, '..', 'node_modules', pkg),
];
const libDir = candidates.find((p) => fs.existsSync(p));

const env = { ...process.env };
if (libDir) {
  const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
  env[key] = env[key] ? `${libDir}:${env[key]}` : libDir;
}

const [, , ...cmd] = process.argv;
if (cmd.length === 0) {
  console.error('with-tts-env: no command given. usage: node with-tts-env.cjs <command> [args...]');
  process.exit(2);
}

const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env, shell: true });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});