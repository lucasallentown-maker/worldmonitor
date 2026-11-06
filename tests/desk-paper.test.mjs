import assert from 'node:assert/strict';
import test from 'node:test';
import { scanCycle } from '../tools/desk-scan/src/scan.mjs';
import { documentedH24TradeCount, planDexEnrich, planGtDossiers, tradeMetrics } from '../tools/desk-scan/src/rules.mjs';
import { holderHistoryReady, recordHolderSnapshot, vetDossier } from '../tools/desk-scan/src/vet.mjs';
import { kellyFraction, sizePaper } from '../tools/desk-scan/src/size.mjs';
import { checkDue, feeFloor, heartbeat, paperEntry, riskCheck, volumeRatio, RISK_SPEC } from '../tools/desk-scan/src/risk.mjs';
import { emptyLedger, paperClose, paperOpen, recoverLedger } from '../tools/desk-scan/src/paper-ledger.mjs';
import { supervise } from '../tools/desk-scan/src/chief.mjs';
import { runPaperFixture } from '../tools/desk-scan/src/paper-cycle.mjs';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const WINDOW = 5 * 60 * 1000;
const CONTRACT = 'So11111111111111111111111111111111111111112';

function windows(count) {
  const trades = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * WINDOW;
    trades.push({ timestamp: start + 1000, side: 'buy', usd: 10, price: 1 });
    trades.push({ timestamp: start + 2000, side: 'sell', usd: 8, price: i === count - 1 ? 1.02 : 1 });
  }
  return trades;
}

test('FIXTURE Dex h24 transaction counts do not require a 24h tape', () => {
  const missing = documentedH24TradeCount({ h24: { buys: 10 } });
  assert.equal(missing.ok, false);
  const twelve = tradeMetrics(windows(12), { start: 0, end: 12 * WINDOW, complete: true }, {
    transactions: { h24: { buys: 140, sells: 80 } },
    volume: { h6: 5000, h24: 20000 },
  });
  assert.equal(twelve.ok, true, twelve.reason);
  assert.equal(twelve.trades_h24, 220);
  const tapeOnly = tradeMetrics(windows(288), { start: 0, end: 288 * WINDOW, complete: true }, {});
  assert.equal(tapeOnly.reason, 'dex-h24-transactions-undocumented');
  const published = tradeMetrics([], { complete: false }, {
    transactions: { h1: { buys: 4, sells: 2 }, h24: { buys: 140, sells: 80 } },
    volume: { h1: 100, h6: 500, h24: 2000 },
    priceChange: { h1: '-1.5' },
  });
  assert.equal(published.ok, true, published.reason);
  assert.equal(published.h1Source, 'published');
  assert.equal(published.buys_h1, 4);
});

test('FIXTURE GT dossiers are capped at 3 and dex enrich stays separate', () => {
  const pools = [1, 2, 3, 4].map((n) => ({
    contract: `Mint${n}${'A'.repeat(28)}`,
    chain: 'solana',
    baseMint: `Mint${n}${'A'.repeat(28)}`,
    liquidityUsd: n * 1000,
  }));
  assert.equal(planDexEnrich(pools).length, 4);
  assert.equal(planGtDossiers(pools).length, 3);
});

test('FIXTURE holder history needs two complete snapshots ten minutes apart', () => {
  const first = recordHolderSnapshot([], { at: NOW - 10 * 60 * 1000, holders: 120, complete: true });
  assert.equal(holderHistoryReady(first.history).reason, 'holder-history-missing');
  const second = recordHolderSnapshot(first.history, { at: NOW, holders: 130, complete: true });
  assert.equal(holderHistoryReady(second.history).ok, true);
  const partial = recordHolderSnapshot(second.history, { at: NOW, holders: 1, complete: false });
  assert.equal(partial.reason, 'snapshot-incomplete');
});

function freshVet(overrides = {}) {
  return {
    cycleFinishedAt: NOW - 60_000,
    mintAuthority: null,
    freezeAuthority: null,
    authorityAt: NOW - 60_000,
    holders: { complete: true, count: 120, at: NOW - 60_000, top1: 0.04, top10: 0.4 },
    liquidityUsd: 50_000,
    liquidityAt: NOW - 60_000,
    feesDocumented: true,
    feesAt: NOW - 60_000,
    price: 1.2,
    pricedAt: NOW - 60_000,
    story: { text: 'FIXTURE world note', at: NOW - 60_000 },
    ...overrides,
  };
}

test('FIXTURE VET rejects unknown authority, stale facts, and social claims', () => {
  assert.equal(vetDossier(freshVet(), NOW).ok, true);
  assert.equal(vetDossier(freshVet({ freezeAuthority: 'set' }), NOW).reasons.includes('freeze-authority-set'), true);
  const noMint = { ...freshVet() };
  delete noMint.mintAuthority;
  assert.ok(vetDossier(noMint, NOW).reasons.includes('mint-authority-unknown'));
  const unknown = { ...freshVet() };
  delete unknown.freezeAuthority;
  assert.ok(vetDossier(unknown, NOW).reasons.includes('freeze-authority-unknown'));
  assert.ok(vetDossier(freshVet({ cycleFinishedAt: NOW - 11 * 60 * 1000 }), NOW).reasons.includes('vet-cycle-stale'));
  assert.ok(vetDossier(freshVet({ holders: { complete: true, count: 90, at: NOW, top1: 0.01, top10: 0.2 } }), NOW).reasons.includes('holders-below-100'));
  assert.ok(vetDossier(freshVet({ social: { available: true } }), NOW).reasons.includes('social-claim-rejected'));
});

const sizeConfig = { retest: true, feeBps: 30, slippageBps: 50, maxFeeRate: 0.05 };

test('FIXTURE size uses free cash only and returns zero Kelly without inputs', () => {
  assert.equal(kellyFraction(null).fraction, 0);
  const absent = sizePaper({
    freeCash: 1000, lockedCapital: 400, bank: 10_000, realizedProfit: 0, liquidityUsd: 100_000,
    kelly: null, config: sizeConfig,
  });
  assert.equal(absent.ok, true);
  assert.equal(absent.notional, 0);
  assert.equal(absent.lockedCapital, 400);
  const sized = sizePaper({
    freeCash: 1000, lockedCapital: 400, bank: 10_000, realizedProfit: 100, liquidityUsd: 100_000,
    kelly: { probability: 0.6, payoff: 2 }, config: sizeConfig,
  });
  assert.equal(sized.ok, true);
  assert.equal(sized.lockedCapital, 400);
  assert.ok(sized.notional <= 10_000 * 0.06);
  assert.ok(sized.notional <= 1000);
  assert.equal(sizePaper({ freeCash: 1000, lockedCapital: 400, realizedProfit: 0, liquidityUsd: 100_000, kelly: null, config: sizeConfig }).reason, 'bank-unconfigured');
  assert.equal(sizePaper({ freeCash: 1000, lockedCapital: 400, realizedProfit: 0, liquidityUsd: 1000, kelly: { probability: 0.6, payoff: 2 }, config: { ...sizeConfig, slippageBps: undefined } }).reason, 'slippage-unconfigured');
});

test('FIXTURE risk refuses malformed volume and measures 5m and 30s clocks', () => {
  assert.equal(volumeRatio(undefined, 100).ratio, null);
  assert.equal(volumeRatio(0, 100).ok, false);
  const ratio = volumeRatio(10, 100);
  assert.equal(ratio.ratio, 10 / (100 / 4));
  const config = { ...RISK_SPEC };
  const healthy = riskCheck({
    config, volumeH6: 30, volumeH24: 100, entryLiquidity: 100, liquidityUsd: 80,
    entryPaperPrice: 2, paperPrice: 1.8,
  });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.exit, false);
  assert.equal(checkDue(NOW, NOW + (5 * 60 * 1000) - 1, 5 * 60 * 1000).due, false);
  assert.equal(checkDue(NOW, NOW + 5 * 60 * 1000, 5 * 60 * 1000).due, true);
  assert.equal(checkDue(NOW, NOW + 29_999, 30_000).due, false);
  assert.equal(checkDue(NOW, NOW + 30_000, 30_000).due, true);
  assert.equal(heartbeat(NOW, NOW + 60_001).stale, true);
  assert.equal(feeFloor(100, 0.001).ok, false);
  assert.equal(paperEntry({ id: 'x' }).live, false);
});

test('FIXTURE paper close deletes only after a confirmed journal event', () => {
  const opened = paperOpen(emptyLedger(), { intentId: 'p1', contract: CONTRACT, qty: 1, paperPrice: 2, at: NOW });
  const again = paperOpen(opened.ledger, { intentId: 'p1', contract: CONTRACT, qty: 1, paperPrice: 2, at: NOW });
  assert.equal(again.idempotent, true);
  const requested = paperClose(opened.ledger, { id: 'p1', at: NOW, confirmed: false });
  assert.equal(requested.deleted, false);
  assert.equal(requested.ledger.positions.p1.status, 'closing');
  const closed = paperClose(requested.ledger, { id: 'p1', at: NOW, paperPrice: 1.5, confirmed: true });
  assert.equal(closed.deleted, true);
  assert.equal(closed.ledger.positions.p1, undefined);
  assert.equal(closed.ledger.events.every((row) => row.pnl === null), true);
  const recovered = recoverLedger(opened.ledger.events);
  assert.equal(recovered.positions.p1.status, 'open');
  const recoveredClosed = recoverLedger(closed.ledger.events);
  assert.equal(recoveredClosed.positions.p1, undefined);
});

test('FIXTURE chief stops new entries after two failures and does not claim a human watch', () => {
  const risk = { ok: true, exit: false };
  const once = supervise({ now: NOW, lastSupervisionAt: NOW - 60_000, failures: [NOW - 1000], risk });
  assert.equal(once.stopNewEntries, false);
  assert.equal(once.humanWatch, false);
  const twice = supervise({ now: NOW, lastSupervisionAt: NOW - 60_000, failures: [NOW - 1000, NOW - 2000], risk });
  assert.equal(twice.stopNewEntries, true);
  assert.equal(supervise({ now: NOW, lastSupervisionAt: NOW - 60_000, failures: null, risk }).stopNewEntries, true);
});

test('FIXTURE paper path runs from a passing scan through a confirmed close', () => {
  const trades = [];
  for (let i = 0; i < 12; i += 1) {
    trades.push({ timestamp: i * WINDOW + 1000, side: 'buy', usd: 10, price: 1 });
    trades.push({ timestamp: i * WINDOW + 2000, side: 'sell', usd: 9, price: 1.01 });
  }
  const scan = {
    now: NOW,
    source: 'fixture',
    wmSufficient: 3,
    pages: [[{
      ticker: 'FIXTURE',
      contract: CONTRACT,
      chain: 'solana',
      baseMint: CONTRACT,
      quoteMint: 'Quote1111111111111111111111111111111111111',
      createdAt: NOW - 60 * 60 * 1000,
      liquidityUsd: 80_000,
      volumeH24Usd: 60_000,
      volumeUsd: { h6: 8000, h24: 60000 },
      transactions: { h24: { buys: 140, sells: 90 } },
      mcap: 200_000,
    }]],
    elapsedMs: 1000,
    bench: { [CONTRACT]: { since: NOW - 26 * 60 * 1000 } },
    trades: { [CONTRACT]: trades },
    observation: { [CONTRACT]: { start: 0, end: 12 * WINDOW, complete: true } },
    accounts: { [CONTRACT]: Array.from({ length: 120 }, (_, i) => ({ owner: `o${i}`, amount: 10, program: 'spl' })) },
    pagination: { [CONTRACT]: { complete: true } },
    mints: { [CONTRACT]: { freezeAuthority: null } },
    snapshots: { [CONTRACT]: [{ at: NOW - 10 * 60 * 1000, holders: 110 }, { at: NOW, holders: 120 }] },
    worldNews: { kind: 'world-news', text: 'FIXTURE shipping note' },
  };
  assert.equal(scanCycle(scan).candidates.length, 1);
  const result = runPaperFixture({
    now: NOW,
    scan,
    intentId: 'paper-1',
    entryPaperPrice: 1.2,
    exitPaperPrice: 1.1,
    vet: freshVet(),
    size: {
      freeCash: 5000, lockedCapital: 1000, bank: 20_000, realizedProfit: 50, liquidityUsd: 80_000,
      kelly: { probability: 0.55, payoff: 1.5 }, config: sizeConfig,
    },
    risk: {
      config: { ...RISK_SPEC },
      volumeH6: 8000, volumeH24: 60000, entryLiquidity: 80_000, liquidityUsd: 70_000,
      entryPaperPrice: 1.2, paperPrice: 1.1,
    },
    failures: [],
  });
  assert.equal(result.ok, true, result.stage);
  assert.equal(result.replay.idempotent, true);
  assert.equal(result.requested.deleted, false);
  assert.equal(result.closed.deleted, true);
  assert.equal(result.recovered.positions['paper-1'], undefined);
  assert.equal(result.entry.submitted, false);
  assert.equal(result.chief.humanWatch, false);
});
