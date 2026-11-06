import assert from 'node:assert/strict';
import test from 'node:test';
import { BENCH_MS } from '../tools/desk-scan/src/rules.mjs';
import { ceilingScenario, FEE_QUOTE_MAX_AGE_MS, feeGate, scenarioFee, userGuard } from '../tools/desk-scan/src/fomo-fees.mjs';
import { paperQuote } from '../tools/desk-scan/src/costs.mjs';
import { sizePaper } from '../tools/desk-scan/src/size.mjs';
import { buildOrderPreview } from '../tools/desk-scan/src/order-preview.mjs';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const FIXTURE = 'FIXTURE — not a live quote';

function quote(side, feeUsd, extra = {}) {
  return {
    fixture: true,
    label: FIXTURE,
    venue: 'fomo.family',
    chain: 'solana',
    side,
    notionalUsd: 12,
    feeUsd,
    at: NOW - 60_000,
    provenance: 'labeled-fixture',
    ...extra,
  };
}

test('the 12 dollar ceiling scenario is 0.24 against the 0.95 user guard', () => {
  const preview = ceilingScenario(200);
  assert.equal(preview.notionalUsd, 12);
  assert.equal(preview.ceilingIsTarget, false);
  assert.equal(preview.liveQuote, false);
  assert.equal(preview.solanaLowFeeUsd, 12 * 0.02);
  assert.equal(preview.userGuardUsd, 0.95);
  assert.equal(preview.conflict, null);
  assert.equal(preview.legacyFloor.status, 'superseded');
  assert.equal(preview.legacyFloor.active, false);
  assert.equal(userGuard(12).formula, 'max(0.0045 * dollars, 0.95)');
  assert.equal(userGuard(12).active, false);
  assert.equal(FEE_QUOTE_MAX_AGE_MS, BENCH_MS);
  assert.equal(BENCH_MS, 25 * 60 * 1000);
});

test('referral changes only the standard 0.50 percent rate', () => {
  const low = scenarioFee({ notionalUsd: 12, chain: 'solana', route: 'solana-low', referralVerified: true });
  assert.equal(low.referralApplied, false);
  assert.equal(low.feeUsd, 12 * 0.02);
  const otherSmall = scenarioFee({ notionalUsd: 12, chain: 'solana', route: 'solana-other', referralVerified: true });
  assert.equal(otherSmall.feeUsd, 0.95);
  const otherLarge = scenarioFee({ notionalUsd: 220, chain: 'solana', route: 'solana-other', referralVerified: true });
  assert.equal(otherLarge.feeUsd, Math.max(220 * 0.0045, 0.95));
  assert.ok(otherLarge.feeUsd > 0.95);
  const noReferral = scenarioFee({ notionalUsd: 220, chain: 'solana', route: 'solana-other', referralVerified: false });
  assert.equal(noReferral.feeUsd, Math.max(220 * 0.005, 0.95));
  assert.equal(scenarioFee({ notionalUsd: 1000, chain: 'solana', route: 'major' }).reason, 'major-minimum-unknown');
  assert.equal(scenarioFee({ notionalUsd: 12, chain: 'solana' }).reason, 'route-not-assumed');
});

test('a quote gates suggestion and does not become a live fill', () => {
  const missingCutoff = feeGate({ notionalUsd: 12, chain: 'solana', now: NOW });
  assert.equal(missingCutoff.reason, 'max-fee-cutoff-unset');
  assert.equal(missingCutoff.notional, 0);
  assert.equal(missingCutoff.filled, false);
  const entryOnly = feeGate({
    notionalUsd: 12,
    chain: 'solana',
    now: NOW,
    maxFeeRate: 0.03,
    maxFeeScope: 'per-leg',
    entry: quote('buy', 0.24),
  });
  assert.equal(entryOnly.reason, 'exit-fee-unknown');
  assert.equal(entryOnly.roundTripKnown, false);
  const high = feeGate({
    notionalUsd: 1000,
    chain: 'solana',
    now: NOW,
    maxFeeRate: 0.01,
    maxFeeScope: 'per-leg',
    allowFixture: true,
    entry: quote('buy', 20, { notionalUsd: 1000 }),
    exit: quote('sell', 20, { notionalUsd: 1000 }),
  });
  assert.equal(high.reason, 'fee-above-max');
  assert.equal(high.notional, 0);
  const guard = feeGate({
    notionalUsd: 12,
    chain: 'solana',
    now: NOW,
    maxFeeRate: 0.03,
    maxFeeScope: 'per-leg',
    allowFixture: true,
    entry: quote('buy', 0.24),
    exit: quote('sell', 0.24),
  });
  assert.equal(guard.pass, true);
  assert.equal(guard.legacyFloorActive, false);
  assert.equal(guard.legacyFloor.status, 'superseded');
  assert.equal(guard.suggest, false);
  assert.equal(guard.filled, false);
  const stale = feeGate({
    notionalUsd: 12,
    chain: 'solana',
    now: NOW,
    maxFeeRate: 0.2,
    maxFeeScope: 'round-trip',
    entry: quote('buy', 0.24, { at: NOW - BENCH_MS - 1 }),
    exit: quote('sell', 0.24),
  });
  assert.equal(stale.reason, 'fee-quote-stale');
  const wrongVenue = feeGate({
    notionalUsd: 12,
    chain: 'solana',
    now: NOW,
    maxFeeRate: 0.2,
    maxFeeScope: 'per-leg',
    entry: quote('buy', 0.24, { venue: 'fomo.fund' }),
    exit: quote('sell', 0.24),
  });
  assert.equal(wrongVenue.reason, 'venue-not-fomo-family');
  const copied = JSON.parse(JSON.stringify(guard));
  assert.equal(copied.entry.feeUsd, 0.24);
  assert.equal(copied.entry.scope, 'per-leg');
  assert.equal(copied.roundTripKnown, true);
  assert.equal(copied.filled, false);
});

test('round-trip 4 percent of entry notional passes at equality and rejects above it', () => {
  const buy = paperQuote({ quotePrice: 2, slippageBps: 100, side: 'buy' });
  const sell = paperQuote({ quotePrice: 2, slippageBps: 100, side: 'sell' });
  assert.equal(buy.paperPrice, 2.02);
  assert.equal(sell.paperPrice, 1.98);
  assert.equal(buy.slippageScope, 'per-side');
  assert.equal(buy.executionPromised, false);
  assert.equal(sell.separateFromFeeCap, true);
  const atLimit = feeGate({
    notionalUsd: 100,
    chain: 'solana',
    now: NOW,
    maxFeeRate: 0.04,
    maxFeeScope: 'round-trip',
    allowFixture: true,
    entry: quote('buy', 2, { notionalUsd: 100 }),
    exit: quote('sell', 2, { notionalUsd: 80 }),
  });
  assert.equal(atLimit.pass, true);
  assert.equal(atLimit.feeRule, 'pass');
  assert.equal(atLimit.roundTripRate, 0.04);
  assert.equal(atLimit.maxFeeBasis, 'entry-notional');
  assert.equal(atLimit.guardConflict, false);
  assert.equal(atLimit.filled, false);
  assert.equal(atLimit.entry.provenance, 'labeled-fixture');
  const over = feeGate({
    notionalUsd: 100,
    chain: 'solana',
    now: NOW,
    maxFeeRate: 0.04,
    maxFeeScope: 'round-trip',
    allowFixture: true,
    entry: quote('buy', 2, { notionalUsd: 100 }),
    exit: quote('sell', 2.01, { notionalUsd: 80 }),
  });
  assert.equal(over.reason, 'fee-above-max');
  assert.equal(over.notional, 0);
  const ceiling = feeGate({
    notionalUsd: 12,
    chain: 'solana',
    now: NOW,
    maxFeeRate: 0.04,
    maxFeeScope: 'round-trip',
    allowFixture: true,
    entry: quote('buy', 0.24),
    exit: quote('sell', 0.24),
  });
  assert.equal(ceiling.feeRule, 'pass');
  assert.equal(ceiling.reason, null);
  assert.equal(ceiling.pass, true);
  assert.equal(ceiling.legacyFloor.active, false);
  assert.equal(ceiling.legacyFloor.usd, 0.95);
  assert.equal(ceiling.roundTripBudgetUsd, 0.48);
  assert.equal(ceiling.maxFeeBasis, 'entry-notional');
  assert.equal(ceiling.filled, false);
  const below = feeGate({
    notionalUsd: 12,
    chain: 'solana',
    now: NOW,
    maxFeeRate: 0.04,
    maxFeeScope: 'round-trip',
    allowFixture: true,
    entry: quote('buy', 0.1),
    exit: quote('sell', 0.1),
  });
  assert.equal(below.pass, true);
  assert.equal(below.legacyFloorActive, false);
  assert.equal(below.filled, false);
  const missing = feeGate({
    notionalUsd: 12,
    chain: 'solana',
    now: NOW,
    maxFeeRate: 0.04,
    maxFeeScope: 'round-trip',
    entry: quote('buy', 0.24),
  });
  assert.equal(missing.reason, 'exit-fee-unknown');
});

test('a cheap verified fixture is not blocked by the superseded fee floor', () => {
  const unset = sizePaper({
    freeCash: 200,
    lockedCapital: 0,
    bank: 200,
    realizedProfit: 0,
    liquidityUsd: 100000,
    kelly: null,
    chain: 'solana',
    now: NOW,
    requireFeeGate: true,
    allowFixture: true,
    entryQuote: quote('buy', 0.1),
    exitQuote: quote('sell', 0.1),
    config: { retest: true, slippageBps: 100, maxFeeRate: 0.04, maxFeeScope: 'round-trip' },
  });
  assert.equal(unset.notional, 0);
  assert.equal(unset.reason, 'kelly-undocumented');
  assert.equal(unset.liveOrder, false);
  const sized = sizePaper({
    freeCash: 12,
    lockedCapital: 0,
    bank: 200,
    realizedProfit: 0,
    liquidityUsd: 100000,
    kelly: { probability: 1, payoff: 1 },
    chain: 'solana',
    now: NOW,
    requireFeeGate: true,
    allowFixture: true,
    entryQuote: quote('buy', 0.1),
    exitQuote: quote('sell', 0.1),
    config: { retest: true, slippageBps: 100, maxFeeRate: 0.04, maxFeeScope: 'round-trip' },
  });
  assert.equal(sized.reason, null);
  assert.equal(sized.notional, 12);
  assert.equal(sized.liveOrder, false);
  assert.equal(sized.bankCeiling, 12);
  const preview = buildOrderPreview({
    config: { bankUsd: 200, freeCashUsd: 200, lockedCapitalUsd: 0, slippageBps: 100, maxFeeRate: 0.04, maxFeeScope: 'round-trip', kelly: null, retest: null },
    now: NOW,
  });
  assert.equal(preview.submitted, false);
  assert.equal(preview.transport, null);
  assert.equal(preview.supportsVenueApi, false);
  assert.equal(preview.notional, 0);
  assert.ok(preview.blockers.includes('kelly-unset'));
  assert.ok(preview.blockers.includes('fee-quote-missing'));
  assert.equal(preview.legacyFloorActive, false);
});
