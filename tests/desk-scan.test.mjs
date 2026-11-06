import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BENCH_MS,
  allowCall,
  cheapFilter,
  pauseFor429,
  worldNewsContext,
} from '../tools/desk-scan/src/rules.mjs';
import { scanCycle } from '../tools/desk-scan/src/scan.mjs';

const NOW = Date.parse('2026-11-06T06:00:00.000Z');
const WINDOW = 5 * 60 * 1000;
const CONTRACT = 'So11111111111111111111111111111111111111112';

function pool(overrides = {}) {
  return {
    ticker: 'FIXTURE',
    contract: CONTRACT,
    chain: 'solana',
    baseMint: CONTRACT,
    quoteMint: 'So11111111111111111111111111111111111111112'.replace('So1', 'Quote'),
    createdAt: NOW - 30 * 60 * 1000,
    liquidityUsd: 20_000,
    volumeH24Usd: 60_000,
    mcap: 100_000,
    fdv: 9_000_000_000,
    ...overrides,
  };
}

function passingInput(overrides = {}) {
  const trades = [];
  for (let i = 0; i < 288; i += 1) {
    const start = i * WINDOW;
    trades.push({ timestamp: start + 1000, side: 'buy', usd: 100, price: 1 });
    if (i >= 276) {
      trades.push({ timestamp: start + 2000, side: 'sell', usd: 40, price: i === 287 ? 1.1 : 1 });
    }
  }
  const accounts = [];
  for (let i = 0; i < 100; i += 1) {
    accounts.push({
      owner: `owner-${i}`,
      amount: 10,
      program: i % 2 === 0 ? 'spl' : 'token2022',
    });
  }
  accounts.push({ owner: 'owner-0', amount: 1, program: 'token2022' });
  accounts.push({ owner: 'treasury', amount: 1, program: 'spl' });
  return {
    now: NOW,
    source: 'fixture',
    fixture: true,
    wmGreens: 3,
    elapsedMs: 1000,
    pages: [[pool()]],
    bench: { [CONTRACT]: { since: NOW - BENCH_MS - 1000 } },
    trades: { [CONTRACT]: trades },
    observation: { [CONTRACT]: { start: 0, end: 288 * WINDOW } },
    accounts: { [CONTRACT]: accounts },
    pagination: { [CONTRACT]: { complete: true, providerLimited: false } },
    mints: { [CONTRACT]: { freezeAuthority: null } },
    snapshots: {
      [CONTRACT]: [
        { at: NOW - 20 * 60 * 1000, holders: 100 },
        { at: NOW, holders: 110 },
      ],
    },
    worldNews: { kind: 'world-news', text: 'FIXTURE headline: shipping delays in the Red Sea.' },
    ...overrides,
  };
}

test('FIXTURE cheap filters use mcap and never FDV', () => {
  assert.equal(cheapFilter(pool(), NOW).ok, true);
  assert.equal(cheapFilter(pool({ mcap: undefined, fdv: 100_000 }), NOW).ok, false);
  assert.equal(cheapFilter(pool({ createdAt: NOW - 5 * 60 * 1000 }), NOW).reason, 'age-outside-10m-48h');
  assert.equal(cheapFilter(pool({ liquidityUsd: 14_999 }), NOW).reason, 'liquidity-below-15k');
  assert.equal(cheapFilter(pool({ volumeH24Usd: 49_999 }), NOW).reason, 'volume-h24-below-50k');
  assert.equal(cheapFilter(pool({ mcap: 79_999 }), NOW).reason, 'mcap-outside-80k-6m');
  assert.equal(cheapFilter(pool({ mcap: 6_000_001 }), NOW).reason, 'mcap-outside-80k-6m');
});

test('FIXTURE shared limiter reserves a slot and pauses 60s on 429', () => {
  let state = { calls: [], pausedUntil: 0 };
  for (let i = 0; i < 4; i += 1) {
    const next = allowCall(state, NOW + i, 'scan');
    assert.equal(next.ok, true);
    state = next.state;
  }
  assert.equal(allowCall(state, NOW + 10, 'scan').reason, 'vet-reservation');
  assert.equal(allowCall(state, NOW + 10, 'vet').reason, 'vet-not-implemented');
  state = pauseFor429(state, NOW);
  assert.equal(allowCall(state, NOW + 1000, 'scan').reason, '429-pause-60s');
  assert.equal(allowCall(state, NOW + 60_000, 'scan').ok, true);
});

test('FIXTURE world news is capped and token sentiment is unavailable', () => {
  const missing = worldNewsContext({ kind: 'token-sentiment', text: 'bullish' });
  assert.equal(missing.context, null);
  assert.equal(missing.unavailable, true);
  const long = worldNewsContext({ kind: 'world-news', text: 'n'.repeat(2000) });
  assert.ok(Buffer.byteLength(long.context, 'utf8') <= 1024);
  assert.equal(long.unavailable, false);
});

test('FIXTURE scan passes one sourced candidate and ranks it', () => {
  const result = scanCycle(passingInput());
  assert.equal(result.fixture, true);
  assert.equal(result.live, false);
  assert.equal(result.candidates.length, 1);
  const row = result.candidates[0];
  assert.equal(row.rank, 1);
  assert.equal(row.degraded, false);
  assert.equal(row.context.includes('Red Sea'), true);
  assert.equal(row.trades_h24 >= 200, true);
  assert.equal(row.sells_h1 > 0, true);
  assert.equal(result.chief.status, 'READY');
  assert.match(row.rank_reason, /holder growth/);
});

test('FIXTURE chief is NOT_READY without three greens', () => {
  const result = scanCycle(passingInput({ wmGreens: 2 }));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.chief.status, 'NOT_READY');
  assert.equal(result.chief.vet, 'not-implemented');
  assert.equal(result.chief.execution, 'disabled');
});

test('FIXTURE position.json stops scanning and does not rewrite the bench', () => {
  const bench = { keep: { since: 1 } };
  const result = scanCycle(passingInput({ position: { contract: CONTRACT }, bench }));
  assert.equal(result.stopped, true);
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.bench, bench);
});

test('FIXTURE h1 buys with zero sells, raw treasury concentration, and incomplete GPA fail closed', () => {
  const buysOnly = passingInput();
  buysOnly.trades[CONTRACT] = buysOnly.trades[CONTRACT].filter((trade) => trade.side !== 'sell');
  for (let i = 276; i < 288; i += 1) {
    for (let n = 0; n < 2; n += 1) {
      buysOnly.trades[CONTRACT].push({
        timestamp: i * WINDOW + 3000 + n,
        side: 'buy',
        usd: 10,
        price: 1,
      });
    }
  }
  const rejectedBuys = scanCycle(buysOnly);
  assert.equal(rejectedBuys.candidates.length, 0);
  assert.ok(rejectedBuys.rejected.some((row) => row.reason === 'h1-zero-sells-20-buys'));

  const concentrated = passingInput();
  concentrated.accounts[CONTRACT] = [
    { owner: 'treasury', amount: 6, program: 'spl' },
    ...Array.from({ length: 100 }, (_, i) => ({ owner: `o${i}`, amount: 1, program: 'spl' })),
  ];
  const rejectedTreasury = scanCycle(concentrated);
  assert.equal(rejectedTreasury.candidates.length, 0);
  assert.ok(rejectedTreasury.rejected.some((row) => row.reason === 'top-owner-above-5pct'));

  const partial = passingInput();
  partial.pagination[CONTRACT] = { complete: false, reason: 'gpa-page-limit' };
  const rejectedPage = scanCycle(partial);
  assert.equal(rejectedPage.candidates.length, 0);
  assert.ok(rejectedPage.rejected.some((row) => row.reason === 'gpa-page-limit'));
});

test('FIXTURE a new pool stays on the bench for 25 minutes', () => {
  const result = scanCycle(passingInput({ bench: {} }));
  assert.equal(result.candidates.length, 0);
  assert.ok(result.rejected.some((row) => row.reason === 'bench-started'));
  assert.equal(result.bench[CONTRACT].since, NOW);
});
