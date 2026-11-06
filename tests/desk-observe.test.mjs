import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configGuide, validatePaperConfig } from '../tools/desk-scan/src/config.mjs';
import { deriveRealizedProfit } from '../tools/desk-scan/src/ledger-profit.mjs';
import { emptyObservation, loadObservation, observeCandidates, persistObservation } from '../tools/desk-scan/src/observe.mjs';
import { ingestSocialEvidence } from '../tools/desk-scan/src/social-evidence.mjs';
import { emptyTimerState, markTimerFired, persistTimerState, resumeDelays, timerHealth, loadTimerState } from '../tools/desk-scan/src/timer-state.mjs';
import { PAPER_INTERVALS_MS } from '../tools/desk-scan/src/timers.mjs';
import { vetDossier } from '../tools/desk-scan/src/vet.mjs';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');

test('observation stores candidate liquidity and holder history without a size', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'observe-'));
  try {
    const first = observeCandidates(emptyObservation(), {
      now: NOW,
      rows: [{
        contract: 'Mint111111111111111111111111111111111111111',
        ticker: 'FIXTURE',
        liquidityUsd: 80000,
        liquiditySource: 'verified-candidate',
        price: 1.2,
        holders: 120,
        holderComplete: true,
        prospective: true,
      }],
    });
    assert.equal(first.state.sizedPositions, false);
    assert.equal(first.state.kelly, null);
    const slot = first.state.records['Mint111111111111111111111111111111111111111'];
    assert.equal(slot.notional, null);
    assert.equal(slot.holderHistory.length, 1);
    const second = observeCandidates(first.state, {
      now: NOW + 10 * 60 * 1000,
      rows: [{
        contract: 'Mint111111111111111111111111111111111111111',
        liquidityUsd: 70000,
        liquiditySource: 'verified-candidate',
        price: 1.1,
        holders: 130,
        holderComplete: true,
      }],
    });
    const later = second.state.records['Mint111111111111111111111111111111111111111'];
    assert.equal(later.holderHistory.length, 2);
    assert.equal(later.outcomes.filter((row) => row.kind === 'price' && row.pnl === null).length, 2);
    assert.equal(later.sized, false);
    const invented = observeCandidates(second.state, {
      now: NOW + 20 * 60 * 1000,
      rows: [{ contract: 'Mint111111111111111111111111111111111111111', liquidityUsd: 1, price: 1 }],
    });
    assert.equal(invented.rejected[0].reason, 'liquidity-not-from-candidate');
    await persistObservation(dir, second.state);
    const loaded = loadObservation(dir);
    assert.equal(loaded.records['Mint111111111111111111111111111111111111111'].holderHistory.length, 2);
    assert.equal(loaded.sizedPositions, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('social evidence waits for input and does not verify posts', () => {
  const waiting = ingestSocialEvidence({ handle: '@Example', now: NOW });
  assert.equal(waiting.status, 'AWAIT_INPUT');
  assert.equal(waiting.verified, false);
  assert.equal(waiting.connector, null);
  const recorded = ingestSocialEvidence({
    handle: 'example',
    now: NOW,
    evidence: {
      source: 'public-x-tool',
      handle: '@Example',
      retrievedAt: NOW,
      posts: [{ id: '1', createdAt: NOW - 60 * 60 * 1000 }],
    },
  });
  assert.equal(recorded.status, 'EVIDENCE_RECORDED');
  assert.equal(recorded.verified, false);
  assert.equal(recorded.recycledProof, false);
  assert.equal(recorded.recycleReason, 'missing-older-posts-cannot-prove-not-recycled');
  assert.equal(ingestSocialEvidence({
    handle: 'example',
    now: NOW,
    evidence: { source: 'public-x-tool', handle: 'example', retrievedAt: NOW, posts: [] },
  }).reason, 'posts-missing-cannot-prove-not-recycled');
  assert.equal(ingestSocialEvidence({
    handle: 'example',
    now: NOW,
    evidence: { available: true, source: 'public-x-tool', handle: 'example', retrievedAt: NOW, posts: [{ id: '1', createdAt: NOW }] },
  }).reason, 'social-claim-rejected');
  const dossier = vetDossier({
    cycleFinishedAt: NOW,
    mintAuthority: null,
    freezeAuthority: null,
    authorityAt: NOW,
    holders: { complete: true, count: 120, at: NOW, top1: 0.01, top10: 0.2 },
    liquidityUsd: 50000,
    liquidityAt: NOW,
    feesDocumented: true,
    feesAt: NOW,
    price: 1,
    pricedAt: NOW,
    story: { text: 'note', at: NOW },
    socialHandle: 'example',
    socialEvidence: { source: 'public-x-tool', handle: 'other', retrievedAt: NOW, posts: [{ id: '1', createdAt: NOW }] },
  }, NOW);
  assert.equal(dossier.ok, false);
  assert.ok(dossier.reasons.includes('social-handle-mismatch'));
});

test('config guide rejects invented liquidity and derives profit from the ledger', () => {
  assert.match(configGuide(), /verified candidate/);
  assert.match(configGuide(), /1 bp = 0.0001/);
  const invented = validatePaperConfig({ liquidityUsd: 10, realizedProfitUsd: 5 });
  assert.ok(invented.reasons.includes('liquidity-not-a-user-input'));
  assert.ok(invented.reasons.includes('realized-profit-must-come-from-ledger'));
  assert.equal(deriveRealizedProfit({ events: [{ type: 'paper-close', confirmed: true, pnl: null }] }, 0).reason, 'ledger-pnl-unknown');
  const fresh = deriveRealizedProfit({ events: [] });
  assert.equal(fresh.usd, 0);
  assert.equal(fresh.source, 'fresh-ledger');
  assert.equal(fresh.realMoneyClaim, false);
  assert.equal(deriveRealizedProfit({ events: [] }, 0).usd, 0);
  assert.equal(deriveRealizedProfit({ events: [{ type: 'paper-close', confirmed: true, pnl: 2 }] }, 1).usd, 3);
});

test('timer health survives a restart and does not invent a last fire', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'timers-'));
  try {
    const marked = markTimerFired(emptyTimerState(), 'closePoll', NOW - 1000);
    await persistTimerState(dir, marked.state);
    const loaded = loadTimerState(dir);
    const resumed = resumeDelays(loaded, NOW);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.delays.closePoll, PAPER_INTERVALS_MS.closePoll - 1000);
    assert.equal(resumed.delays.risk, 0);
    assert.equal(timerHealth({ schema: 'nope' }, NOW).reason, 'timer-state-missing');
    const skewed = markTimerFired(emptyTimerState(), 'risk', NOW + 10 * 60 * 1000);
    assert.equal(timerHealth(skewed.state, NOW).reason, 'clock-invalid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
