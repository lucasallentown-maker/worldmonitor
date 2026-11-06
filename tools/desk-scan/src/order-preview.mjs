// Manual paper preview. Nothing here is submitted. fomo.family has no verified
// order API in this process.

import { feeGate } from './fomo-fees.mjs';
import { kellyFraction } from './size.mjs';
import { paperQuote } from './costs.mjs';

export function buildOrderPreview({
  config = {},
  entryQuote = null,
  exitQuote = null,
  quotePrice = null,
  chain = 'solana',
  now = Date.now(),
} = {}) {
  const kelly = kellyFraction(config.kelly);
  const notional = kelly.ok && kelly.fraction > 0 && Number.isFinite(config.freeCashUsd)
    ? config.freeCashUsd * kelly.fraction
    : 0;
  const blockers = [];
  if (!kelly.ok || kelly.fraction === 0) blockers.push('kelly-unset');
  if (config.retest !== true) blockers.push('retest-unset');
  let fee = null;
  if (!entryQuote || !exitQuote) {
    blockers.push('fee-quote-missing');
  } else if (!(notional > 0)) {
    fee = { ok: false, reason: 'no-sized-order', filled: false, liveOrder: false, liveQuote: false };
  } else {
    fee = feeGate({
      notionalUsd: notional,
      chain,
      entry: entryQuote,
      exit: exitQuote,
      maxFeeRate: config.maxFeeRate,
      maxFeeScope: config.maxFeeScope,
      now,
      allowFixture: false,
    });
    if (!fee.pass || !fee.suggest) blockers.push(fee.reason || 'fee-blocked');
  }
  const slippage = Number.isFinite(config.slippageBps) && Number.isFinite(quotePrice)
    ? {
      buy: paperQuote({ quotePrice, slippageBps: config.slippageBps, side: 'buy' }),
      sell: paperQuote({ quotePrice, slippageBps: config.slippageBps, side: 'sell' }),
    }
    : null;
  return {
    schema: 'paper-order-preview/v1',
    approval: 'manual',
    submitted: false,
    transport: null,
    venue: 'fomo.family',
    venueApi: 'unverified',
    supportsVenueApi: false,
    paper: true,
    liveOrder: false,
    notional,
    sizeReason: blockers.includes('kelly-unset') ? 'kelly-undocumented' : null,
    fee,
    slippage,
    blockers,
    legacyFloor: 'superseded',
    legacyFloorActive: false,
  };
}
