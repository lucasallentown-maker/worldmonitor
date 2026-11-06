#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { writeHandoff } from './src/handoff-view.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const summary = arg('--summary');
const config = arg('--config');
const out = arg('--out');
if (!summary || !config || !out) {
  console.error('usage: node tools/desk-scan/handoff.mjs --summary <summary.json> --config <paper.bank.json> --out <handoff.html>');
  process.exit(2);
}
const built = writeHandoff(summary, config);
writeFileSync(out, built.html);
console.log(`HANDOFF wrote ${out} candidates=${built.view.candidates.length} suggested=${built.view.paper.suggestedNotionalUsd} order=false`);
