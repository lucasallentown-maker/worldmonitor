#!/usr/bin/env node
// Child used by the kill-during-close test. It writes one paper open, then
// a confirmed close, and SIGKILLs itself at the requested write boundary.

import { durableClose, durableOpen } from './src/durable-ledger.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const dir = arg('--dir');
const crashAt = arg('--crash-at');
if (!dir || !crashAt) {
  console.error('usage: crash-close.mjs --dir <dir> --crash-at <point>');
  process.exit(2);
}

const at = Date.parse('2026-11-06T12:00:00.000Z');
await durableOpen(dir, {
  intentId: 'paper-1',
  contract: 'So11111111111111111111111111111111111111112',
  qty: 10,
  paperPrice: 1.2,
  at,
  provenance: 'paper-crash-test',
});
await durableClose(dir, {
  id: 'paper-1',
  at: at + 1,
  paperPrice: 1.1,
  confirmed: true,
  provenance: 'paper-crash-test',
}, { crashAt });
console.log('completed-without-kill');
