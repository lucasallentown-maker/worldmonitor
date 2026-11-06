#!/usr/bin/env node
// Local World Monitor data plane.
//
// Starts Redis and docker/redis-rest-proxy.mjs on 127.0.0.1, runs the seeders
// that fill the three RPC keys, then starts `npm run dev` on 127.0.0.1.
// Does not open a public port, does not call api.worldmonitor.app, and does not
// kill a process that already owns a port.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReadiness } from './readiness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(ROOT, '.local-backend');
const LOGS = path.join(STATE, 'logs');

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(major) || major < 20) {
  console.error(`Node.js >= 20 is required (this process is ${process.version})`);
  process.exit(2);
}

const SEEDERS = [
  ['seed-crypto-quotes.mjs', 180_000],
  ['seed-market-breadth.mjs', 180_000],
  ['seed-fear-greed.mjs', 240_000],
  ['seed-earthquakes.mjs', 180_000],
  ['seed-weather-alerts.mjs', 240_000],
  ['seed-commodity-quotes.mjs', 300_000],
  ['seed-cross-source-signals.mjs', 120_000],
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function firstFree(start, count) {
  for (let port = start; port < start + count; port += 1) {
    if (await portFree(port)) return port;
  }
  throw new Error(`no free port in ${start}-${start + count - 1}`);
}

function logFd(name) {
  mkdirSync(LOGS, { recursive: true });
  return openSync(path.join(LOGS, name), 'a');
}

function startDetached(cmd, args, { env, logName, cwd = ROOT }) {
  const child = spawn(cmd, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', logFd(logName), logFd(logName)],
  });
  child.unref();
  return child.pid;
}

function runWait(cmd, args, { env, logName, cwd = ROOT, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', logFd(logName), logFd(logName)],
    });
    let timer = null;
    const finish = (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, signal: signal || null });
    };
    child.on('exit', finish);
    child.on('error', () => finish(1, 'error'));
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, 5000).unref();
      }, timeoutMs);
    }
  });
}

async function waitFor(label, fn, tries = 40) {
  let last = 'not ready';
  for (let i = 0; i < tries; i += 1) {
    try {
      if (await fn()) return;
    } catch (err) {
      last = err.message;
    }
    await sleep(250);
  }
  throw new Error(`${label} did not become ready (${last})`);
}

async function ensureRedisClient() {
  const pkg = path.join(HERE, 'node_modules', 'redis', 'package.json');
  if (existsSync(pkg)) return;
  console.log('Installing redis@4 for the local REST proxy');
  const installed = await runWait('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: HERE,
    env: process.env,
    logName: 'npm-redis.log',
    timeoutMs: 180_000,
  });
  if (installed.code !== 0 || !existsSync(pkg)) {
    throw new Error('npm install in scripts/local-backend failed; see .local-backend/logs/npm-redis.log');
  }
}

function readProc(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, 'utf8');
    return {
      pid,
      rssKb: Number(text.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0),
      hwmKb: Number(text.match(/^VmHWM:\s+(\d+)/m)?.[1] || 0),
    };
  } catch {
    return { pid, rssKb: 0, hwmKb: 0, missing: true };
  }
}

function cpuTicks(pid) {
  try {
    const parts = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    return Number(parts[13] || 0) + Number(parts[14] || 0);
  } catch {
    return 0;
  }
}

async function sampleResources(pids) {
  const before = Object.fromEntries(Object.entries(pids).map(([name, pid]) => [name, cpuTicks(pid)]));
  const started = Date.now();
  await sleep(2000);
  const elapsed = Date.now() - started;
  const processes = {};
  let rssKb = 0;
  for (const [name, pid] of Object.entries(pids)) {
    const status = readProc(pid);
    const ticks = cpuTicks(pid) - (before[name] || 0);
    const cpuPercent = elapsed > 0 ? Math.round((ticks / (elapsed / 10)) * 100) / 100 : 0;
    processes[name] = { ...status, cpuPercent };
    rssKb += status.rssKb || 0;
  }
  return { rssKb, processes, at: new Date().toISOString() };
}

function writePids(pids) {
  writeFileSync(path.join(STATE, 'pids.json'), `${JSON.stringify(pids, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  mkdirSync(STATE, { recursive: true });
  await ensureRedisClient();

  const redisPort = await firstFree(6379, 20);
  const restPort = await firstFree(8079, 20);
  const password = randomBytes(32).toString('hex');
  const token = randomBytes(32).toString('hex');
  const redisUrl = `http://127.0.0.1:${restPort}`;

  writeFileSync(path.join(STATE, 'redis.conf'), [
    'bind 127.0.0.1',
    'protected-mode yes',
    `port ${redisPort}`,
    `requirepass ${password}`,
    'daemonize no',
    'save ""',
    'appendonly no',
    `dir ${STATE}`,
    'logfile ""',
    '',
  ].join('\n'), { mode: 0o600 });

  console.log(`Redis 127.0.0.1:${redisPort}`);
  console.log(`REST  ${redisUrl}`);

  const redisPid = startDetached('redis-server', [path.join(STATE, 'redis.conf')], {
    env: process.env,
    logName: 'redis.log',
  });
  writePids({ redis: redisPid, redisPort, restPort });

  await waitFor('redis', async () => {
    const ping = spawn('redis-cli', ['-h', '127.0.0.1', '-p', String(redisPort), 'ping'], {
      env: { ...process.env, REDISCLI_AUTH: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = await new Promise((resolve) => {
      let buf = '';
      ping.stdout.on('data', (chunk) => { buf += chunk; });
      ping.on('exit', () => resolve(buf));
    });
    return out.includes('PONG');
  });

  const proxyPid = startDetached(process.execPath, [
    '--import', path.join(HERE, 'register-redis-hook.mjs'),
    path.join(ROOT, 'docker', 'redis-rest-proxy.mjs'),
  ], {
    env: {
      ...process.env,
      SRH_BIND_HOST: '127.0.0.1',
      PORT: String(restPort),
      SRH_TOKEN: token,
      SRH_CONNECTION_STRING: `redis://:${password}@127.0.0.1:${redisPort}`,
    },
    logName: 'proxy.log',
  });
  writePids({ redis: redisPid, proxy: proxyPid, redisPort, restPort });

  await waitFor('redis-rest', async () => {
    const response = await fetch(redisUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['PING']),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body.result === 'PONG';
  });

  const seedEnv = {
    ...process.env,
    UPSTASH_REDIS_REST_URL: redisUrl,
    UPSTASH_REDIS_REST_TOKEN: token,
  };
  const seedResults = [];
  for (const [file, timeoutMs] of SEEDERS) {
    console.log(`seeding ${file}`);
    const started = Date.now();
    const result = await runWait(process.execPath, [path.join(ROOT, 'scripts', file)], {
      env: seedEnv,
      logName: `seed-${file}.log`,
      timeoutMs,
    });
    seedResults.push({ file, code: result.code, signal: result.signal, elapsedMs: Date.now() - started });
    console.log(`  ${file} exit=${result.code} ${Math.round((Date.now() - started) / 1000)}s`);
  }

  const apiPort = await firstFree(3000, 20);
  const apiBase = `http://127.0.0.1:${apiPort}`;
  writeFileSync(path.join(ROOT, '.env.local-backend'), [
    '# Generated by scripts/local-backend/up.mjs. Gitignored. Do not commit.',
    `UPSTASH_REDIS_REST_URL=${redisUrl}`,
    `UPSTASH_REDIS_REST_TOKEN=${token}`,
    `WM_API_BASE=${apiBase}`,
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(path.join(ROOT, '.env.local-backend'), 0o600);
  console.log(`API   ${apiBase}`);

  const vitePid = startDetached('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(apiPort), '--strictPort'], {
    env: { ...seedEnv, BROWSER: 'none' },
    logName: 'vite.log',
  });
  writePids({ redis: redisPid, proxy: proxyPid, vite: vitePid, redisPort, restPort, apiPort });

  await waitFor('vite', async () => {
    const response = await fetch(apiBase, { signal: AbortSignal.timeout(2000) });
    return response.status === 200 || response.status === 302;
  }, 80);

  const startup = await sampleResources({ redis: redisPid, proxy: proxyPid, vite: vitePid });
  await sleep(12_000);
  const steady = await sampleResources({ redis: redisPid, proxy: proxyPid, vite: vitePid });

  console.log('readiness (up to 10 attempts, 3s apart)');
  const report = await runReadiness({ apiBase, redisUrl, redisToken: token });
  const proof = {
    schema: 'worldmonitor-local-proof/v1',
    live: true,
    fixture: false,
    node: process.version,
    command: 'node scripts/local-backend/up.mjs',
    apiBase,
    redisUrl,
    seeders: seedResults,
    resources: { startup, steady },
    readiness: report,
    checkedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(STATE, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(path.join(STATE, 'readiness.json'), `${JSON.stringify({
    schema: 'worldmonitor-local-readiness/v1',
    live: true,
    fixture: false,
    ok: report.ok,
    greens: report.sufficientGreens,
    httpGreens: report.httpGreens,
    sufficientGreens: report.sufficientGreens,
    reason: report.reason,
    attemptsRun: report.attempts.length,
    attempts: report.attempts,
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(report.ok ? 'SUFFICIENT 3/3' : `NOT SUFFICIENT (${report.reason})`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
