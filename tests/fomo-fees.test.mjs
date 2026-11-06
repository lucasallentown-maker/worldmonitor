import assert from 'node:assert/strict';
import test from 'node:test';
import { BENCH_MS } from '../tools/desk-scan/src/rules.mjs';
import { ceilingScenario, FEE_QUOTE_MAX_AGE_MS, feeGate, scenarioFee, userGuard } from '../tools/desk-scan/src/fomo-fees.mjs';
import { sizePaper } from '../tools/desk-scan/src/size.mjs';

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
  assert.equal(preview.conflict, 'scenario-cheap-route-below-user-guard');
  assert.equal(userGuard(12).formula, 'max(0.0045 * dollars, 0.95)');
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
  assert.equal(guard.reason, 'user-guard-above-max-fee');
  assert.equal(guard.conflict, 'quoted-fee-below-user-guard');
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

test('paper sizing keeps the bank and does not invent cash when the fee gate rejects', () => {
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
    entryQuote: quote('buy', 0.24),
    exitQuote: quote('sell', 0.24),
    config: { retest: true, slippageBps: 50, maxFeeRate: 0.03, maxFeeScope: 'per-leg' },
  });
  assert.equal(sized.notional, 0);
  assert.equal(sized.reason, 'user-guard-above-max-fee');
  assert.equal(sized.liveOrder, false);
  assert.equal(sized.lockedCapital, 0);
  assert.equal(sized.bankCeiling, 12);
});
