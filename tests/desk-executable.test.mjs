import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { paperCost, paperQuote } from '../tools/desk-scan/src/costs.mjs';
import { validatePaperConfig } from '../tools/desk-scan/src/config.mjs';
import { planExecutablePaper } from '../tools/desk-scan/src/executable.mjs';
import { createPaperTimers, PAPER_INTERVALS_MS } from '../tools/desk-scan/src/timers.mjs';

test('quote and cost use basis points and stay empty without rates', () => {
  assert.equal(paperQuote({ quotePrice: 1, slippageBps: 50 }).paperPrice, 1.005);
  assert.equal(paperQuote({ quotePrice: 1 }).reason, 'slippage-unconfigured');
  assert.equal(paperQuote({ quotePrice: 1 }).paperPrice, null);
  const cost = paperCost({ notionalUsd: 1000, feeBps: 30, slippageBps: 50 });
  assert.equal(cost.feeUsd, 3);
  assert.equal(cost.slippageUsd, 5);
  assert.equal(cost.totalUsd, 8);
  assert.equal(cost.venueSchedule, null);
  assert.equal(paperCost({ notionalUsd: 1000 }).feeUsd, null);
});

test('the example config leaves the bank unset and does not apply 200', () => {
  const example = JSON.parse(readFileSync(new URL('../tools/desk-scan/paper.config.example.json', import.meta.url), 'utf8'));
  const plan = planExecutablePaper(example, { quotePrice: 1 });
  assert.equal(plan.ok, false);
  assert.equal(plan.notional, null);
  assert.equal(plan.costs, null);
  assert.equal(plan.bankDefaultApplied, false);
  assert.equal(plan.social.status, 'PASS_PARTIAL');
  assert.equal(plan.social.verifiedReads, null);
  assert.ok(plan.missing.includes('bankUsd'));
  assert.ok(plan.decisions.includes('kelly.probability'));
  assert.equal(plan.timers.risk, PAPER_INTERVALS_MS.risk);
  assert.equal(plan.timersStarted, false);
  const copied = validatePaperConfig({ ...example, bankUsd: 200, freeCashUsd: 50, lockedCapitalUsd: 0, realizedProfitUsd: 0, liquidityUsd: 1000, feeBps: 30, slippageBps: 50, maxFeeRate: 0.05, retest: true });
  assert.equal(copied.ok, false);
  assert.equal(copied.bankUsd, null);
  assert.ok(copied.reasons.includes('prior-desk-200-not-authorized-as-default'));
});

test('configured bps produce a cost ledger and unset Kelly sizes zero', () => {
  const plan = planExecutablePaper({
    bankUsd: 1000,
    bankUsdSource: 'user-entered',
    freeCashUsd: 1000,
    lockedCapitalUsd: 0,
    realizedProfitUsd: 0,
    liquidityUsd: 100000,
    feeBps: 30,
    slippageBps: 50,
    maxFeeRate: 0.05,
    retest: true,
    kelly: { probability: null, payoff: null },
    socialHandle: null,
  }, { quotePrice: 2 });
  assert.equal(plan.ok, true);
  assert.equal(plan.sizeReady, false);
  assert.equal(plan.notional, 0);
  assert.equal(plan.costs.totalUsd, 0);
  assert.equal(plan.quote.paperPrice, 2.01);
  assert.equal(plan.pnl, null);
  assert.equal(plan.liveOrder, false);
});

test('paper timers are armed on separate delays', async () => {
  const armed = [];
  const clock = createPaperTimers({
    schedule(fn, ms) {
      const handle = { fn, ms };
      armed.push(handle);
      return handle;
    },
    clear(handle) {
      handle.cleared = true;
    },
    onRisk() {},
    onClosePoll() {},
    onChief() {},
  });
  clock.start();
  assert.deepEqual(armed.map((row) => row.ms), [PAPER_INTERVALS_MS.risk, PAPER_INTERVALS_MS.closePoll, PAPER_INTERVALS_MS.chief]);
  armed[1].fn();
  assert.equal(armed.filter((row) => row.ms === PAPER_INTERVALS_MS.risk).length, 1);
  assert.equal(armed.filter((row) => row.ms === PAPER_INTERVALS_MS.closePoll).length, 2);
  clock.stop();
  assert.equal(armed.at(-1).cleared, true);

  let risk = 0;
  let close = 0;
  let chief = 0;
  const real = createPaperTimers({
    intervals: { risk: 40, closePoll: 20, chief: 60 },
    schedule: setTimeout,
    clear: clearTimeout,
    onRisk: () => { risk += 1; },
    onClosePoll: () => { close += 1; },
    onChief: () => { chief += 1; },
  });
  real.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  real.stop();
  assert.ok(close >= 2);
  assert.ok(risk >= 1);
  assert.ok(chief >= 1);
  assert.ok(close > risk);
});
