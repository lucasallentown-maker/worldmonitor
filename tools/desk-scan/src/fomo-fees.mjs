// Published fomo.family fees. fomo.fund is a different name and is rejected.
// A scenario is not a quote. The displayed quote is the fee that can pass a
// gate. Cheap route and referral are not assumed. The user guard
// max(0.0045 * dollars, 0.95) is a separate policy, not this schedule.

import { BENCH_MS } from './rules.mjs';

export const VENUE = 'fomo.family';
export const FEE_SOURCES = Object.freeze([
  'https://help.fomo.family/en/articles/14436214-trading-fees-on-fomo',
  'https://help.fomo.family/en/articles/15171268-how-referral-codes-and-fee-discounts-work',
]);
export const FEE_QUOTE_MAX_AGE_MS = BENCH_MS;

const STANDARD_RATE = 0.005;
const REFERRAL_STANDARD_RATE = 0.0045;
const LOW_BAND_RATE = 0.02;
const MAJOR_RATE = 0.0005;

function roundTripBlock(extra) {
  return {
    ok: false,
    pass: false,
    suggest: false,
    filled: false,
    liveOrder: false,
    liveQuote: false,
    notional: 0,
    paper: true,
    ...extra,
  };
}

export function userGuard(dollars) {
  if (!Number.isFinite(dollars) || dollars <= 0) {
    return { ok: false, kind: 'user-guard', officialSchedule: false, usd: null, rate: null, reason: 'fee-dollars-invalid' };
  }
  const usd = Math.max(0.0045 * dollars, 0.95);
  return {
    ok: true,
    kind: 'user-guard',
    officialSchedule: false,
    formula: 'max(0.0045 * dollars, 0.95)',
    usd,
    rate: usd / dollars,
    reason: null,
  };
}

export function scenarioFee({ notionalUsd, chain, route, referralVerified = false, networkFeeUsd = null } = {}) {
  const base = {
    kind: 'scenario',
    liveQuote: false,
    filled: false,
    officialSchedule: true,
    venue: VENUE,
    sources: FEE_SOURCES,
    assumedRoute: false,
    notionalUsd: notionalUsd ?? null,
    feeUsd: null,
    rate: null,
  };
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return { ...base, ok: false, reason: 'fee-dollars-invalid' };
  if (chain !== 'solana' && chain !== 'other') return { ...base, ok: false, reason: 'chain-unknown' };
  if (route === 'major') {
    return { ...base, ok: false, reason: 'major-minimum-unknown', majorRate: MAJOR_RATE, referralApplied: false };
  }
  if (chain === 'other') {
    const rate = referralVerified ? REFERRAL_STANDARD_RATE : STANDARD_RATE;
    const fomoFeeUsd = notionalUsd * rate;
    if (!Number.isFinite(networkFeeUsd) || networkFeeUsd < 0) {
      return { ...base, ok: false, reason: 'network-fee-unknown', fomoFeeUsd, networkFeeUsd: null, referralApplied: referralVerified };
    }
    const feeUsd = fomoFeeUsd + networkFeeUsd;
    return { ...base, ok: true, reason: null, feeUsd, rate: feeUsd / notionalUsd, fomoFeeUsd, networkFeeUsd, referralApplied: referralVerified, scope: 'per-leg' };
  }
  if (route === 'solana-low') {
    let feeUsd;
    let referralApplied = false;
    if (notionalUsd < 5) feeUsd = 0.10;
    else if (notionalUsd < 47.5) feeUsd = notionalUsd * LOW_BAND_RATE;
    else if (notionalUsd < 190) feeUsd = 0.95;
    else {
      const rate = referralVerified ? REFERRAL_STANDARD_RATE : STANDARD_RATE;
      feeUsd = notionalUsd * rate;
      referralApplied = referralVerified;
    }
    return {
      ...base,
      ok: true,
      reason: null,
      feeUsd,
      rate: feeUsd / notionalUsd,
      gasCovered: true,
      networkFeeUsd: 0,
      referralApplied,
      scope: 'per-leg',
    };
  }
  if (route === 'solana-other') {
    const rate = referralVerified ? REFERRAL_STANDARD_RATE : STANDARD_RATE;
    const feeUsd = Math.max(notionalUsd * rate, 0.95);
    return {
      ...base,
      ok: true,
      reason: null,
      feeUsd,
      rate: feeUsd / notionalUsd,
      gasCovered: true,
      networkFeeUsd: 0,
      referralApplied: referralVerified,
      minimumUsd: 0.95,
      scope: 'per-leg',
    };
  }
  return { ...base, ok: false, reason: 'route-not-assumed' };
}

export function ceilingScenario(bankUsd) {
  const notionalUsd = Number.isFinite(bankUsd) ? bankUsd * 0.06 : null;
  const low = scenarioFee({ notionalUsd, chain: 'solana', route: 'solana-low', referralVerified: false });
  const guard = userGuard(notionalUsd);
  const conflict = low.ok && guard.ok && low.feeUsd < guard.usd ? 'scenario-cheap-route-below-user-guard' : null;
  return {
    kind: 'scenario',
    liveQuote: false,
    filled: false,
    ceilingIsTarget: false,
    notionalUsd,
    solanaLowFeeUsd: low.feeUsd,
    userGuardUsd: guard.usd,
    conflict,
    low,
    guard,
    note: 'Scenario only. A displayed quote governs. The cheap route and a referral are not assumed.',
  };
}

function readQuote(quote, { now, notionalUsd, chain, side }) {
  if (!quote || typeof quote !== 'object') return { ok: false, reason: 'fee-quote-missing', liveQuote: false, filled: false };
  const fixture = quote.fixture === true;
  if (fixture && quote.label !== 'FIXTURE — not a live quote') return { ok: false, reason: 'fixture-unlabeled', liveQuote: false, filled: false };
  if (quote.venue !== VENUE) return { ok: false, reason: 'venue-not-fomo-family', liveQuote: false, filled: false };
  if (quote.chain !== chain) return { ok: false, reason: 'fee-chain-mismatch', liveQuote: false, filled: false };
  if (quote.side !== side) return { ok: false, reason: 'fee-side-mismatch', liveQuote: false, filled: false };
  if (!Number.isFinite(quote.feeUsd) || quote.feeUsd < 0) return { ok: false, reason: 'fee-missing', liveQuote: false, filled: false };
  if (!Number.isFinite(quote.notionalUsd) || Math.abs(quote.notionalUsd - notionalUsd) > 0.001) {
    return { ok: false, reason: 'fee-notional-mismatch', liveQuote: false, filled: false };
  }
  if (typeof quote.provenance !== 'string' || quote.provenance.trim() === '') {
    return { ok: false, reason: 'fee-unverifiable', liveQuote: false, filled: false };
  }
  if (!Number.isFinite(quote.at) || !Number.isFinite(now)) return { ok: false, reason: 'fee-unverifiable', liveQuote: false, filled: false };
  const age = now - quote.at;
  if (age < -120_000) return { ok: false, reason: 'fee-quote-future', liveQuote: false, filled: false };
  if (age > FEE_QUOTE_MAX_AGE_MS) return { ok: false, reason: 'fee-quote-stale', liveQuote: false, filled: false };
  return {
    ok: true,
    reason: null,
    fixture,
    liveQuote: false,
    filled: false,
    feeUsd: quote.feeUsd,
    rate: quote.feeUsd / notionalUsd,
    side,
    scope: 'per-leg',
    provenance: quote.provenance,
    at: quote.at,
  };
}

export function feeGate({
  notionalUsd,
  chain,
  entry = null,
  exit = null,
  maxFeeRate = null,
  maxFeeScope = null,
  now = Date.now(),
  allowFixture = false,
} = {}) {
  const guard = userGuard(notionalUsd);
  if (!guard.ok) return roundTripBlock({ reason: guard.reason, guard });
  if (!Number.isFinite(maxFeeRate) || maxFeeRate <= 0) {
    return roundTripBlock({ reason: 'max-fee-cutoff-unset', guard, entry: null, exit: null });
  }
  if (maxFeeScope !== 'per-leg' && maxFeeScope !== 'round-trip') {
    return roundTripBlock({ reason: 'max-fee-scope-unset', guard });
  }
  const entryRead = readQuote(entry, { now, notionalUsd, chain, side: 'buy' });
  if (!entryRead.ok) return roundTripBlock({ reason: entryRead.reason, guard, roundTripKnown: false, roundTripUncertainty: 'entry-fee-unknown' });
  const exitRead = readQuote(exit, { now, notionalUsd, chain, side: 'sell' });
  if (!exitRead.ok) {
    return roundTripBlock({
      reason: exit ? exitRead.reason : 'exit-fee-unknown',
      guard,
      entry: entryRead,
      roundTripKnown: false,
      roundTripUncertainty: 'exit-fee-unknown',
      conflict: entryRead.feeUsd < guard.usd ? 'quoted-fee-below-user-guard' : null,
    });
  }
  const roundTripUsd = entryRead.feeUsd + exitRead.feeUsd;
  const roundTripRate = roundTripUsd / notionalUsd;
  const fixture = entryRead.fixture || exitRead.fixture;
  const conflict = entryRead.feeUsd < guard.usd || exitRead.feeUsd < guard.usd ? 'quoted-fee-below-user-guard' : null;
  if (guard.rate > maxFeeRate) {
    return roundTripBlock({
      reason: 'user-guard-above-max-fee',
      guard,
      entry: entryRead,
      exit: exitRead,
      roundTripUsd,
      roundTripRate,
      roundTripKnown: true,
      conflict,
      maxFeeScope,
    });
  }
  const above = maxFeeScope === 'per-leg'
    ? entryRead.rate > maxFeeRate || exitRead.rate > maxFeeRate
    : roundTripRate > maxFeeRate;
  if (above) {
    return roundTripBlock({
      reason: 'fee-above-max',
      guard,
      entry: entryRead,
      exit: exitRead,
      roundTripUsd,
      roundTripRate,
      roundTripKnown: true,
      conflict,
      maxFeeScope,
    });
  }
  if (fixture && !allowFixture) {
    return roundTripBlock({
      reason: 'fixture-not-a-live-quote',
      guard,
      entry: entryRead,
      exit: exitRead,
      roundTripUsd,
      roundTripRate,
      roundTripKnown: true,
      conflict,
      maxFeeScope,
      pass: true,
    });
  }
  return {
    ok: true,
    pass: true,
    suggest: !fixture,
    filled: false,
    liveOrder: false,
    liveQuote: false,
    fixture,
    paper: true,
    notional: notionalUsd,
    reason: null,
    guard,
    entry: entryRead,
    exit: exitRead,
    roundTripUsd,
    roundTripRate,
    roundTripKnown: true,
    roundTripUncertainty: null,
    conflict,
    maxFeeScope,
  };
}
