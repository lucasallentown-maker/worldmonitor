#!/usr/bin/env node
// Stops only the processes recorded by up.mjs. Never signals an unrelated pid.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PID_FILE = path.join(ROOT, '.local-backend', 'pids.json');

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

function stop(pid, expected) {
  const cmd = cmdline(pid);
  if (!cmd) {
    console.log(`pid ${pid} already gone`);
    return;
  }
  if (!expected.some((part) => cmd.includes(part))) {
    console.log(`refusing to stop pid ${pid}; cmdline does not match this backend`);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    console.log(`stopped process group ${pid}`);
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`stopped pid ${pid}`);
    } catch (err) {
      console.log(`pid ${pid}: ${err.message}`);
    }
  }
}

if (!existsSync(PID_FILE)) {
  console.log('no pid file');
  process.exit(0);
}
const pids = JSON.parse(readFileSync(PID_FILE, 'utf8'));
stop(pids.vite, ['vite', 'npm run dev']);
stop(pids.proxy, ['redis-rest-proxy.mjs']);
stop(pids.redis, ['redis-server']);
