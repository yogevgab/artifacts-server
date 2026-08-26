#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'plugins/rtfx/scripts');
const dxt = join(root, 'dxt/rtfx');
const server = join(dxt, 'server');
const dist = join(root, 'dist');
const out = join(dist, 'rtfx.dxt');

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

rmSync(server, { recursive: true, force: true });
mkdirSync(server, { recursive: true });
for (const file of [
  'rtfx-mcp.mjs',
  'rtfx.mcp.lib.mjs',
  'rtfx.lib.mjs',
  'rtfx.bundle.mjs',
  'rtfx.oauth.mjs',
  'rtfx.oauth.lib.mjs',
]) {
  cpSync(join(src, file), join(server, file));
}

mkdirSync(dist, { recursive: true });
rmSync(out, { force: true });

run('npx', ['@anthropic-ai/dxt', 'validate', join(dxt, 'manifest.json')]);
run('npx', ['@anthropic-ai/dxt', 'pack', dxt, out]);
if (!existsSync(out)) throw new Error(`expected ${out}`);
run('npx', ['@anthropic-ai/dxt', 'info', out]);
console.log(`Packed ${out}`);
