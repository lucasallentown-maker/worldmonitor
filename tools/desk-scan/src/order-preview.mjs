// Manual paper preview. Nothing here is submitted. fomo.family has no verified
// order API in this process.

import { feeGate } from './fomo-fees.mjs';
import { kellyFraction, sizePaper } from './size.mjs';
import { paperQuote } from './costs.mjs';

export function buildOrderPreview({
  config = {},
  entryQuote = null,
  exitQuote = null,
  quotePrice = null,
  chain = 'solana',
  now = Date.now(),
} = {}) {
  const fixedMode = config.sizeMode === 'paper_fixed_fraction';
  const kelly = kellyFraction(config.kelly);
  let notional = 0;
  let preFeeNotional = null;
  let feeBudget = null;
  const blockers = [];
  if (fixedMode) {
    const sized = sizePaper({
      freeCash: config.freeCashUsd,
      lockedCapital: config.lockedCapitalUsd,
      bank: config.bankUsd,
      realizedProfit: 0,
      liquidityUsd: null,
      config,
      chain,
      now,
      entryQuote,
      exitQuote,
      allowFixture: false,
    });
    notional = sized.notional;
    preFeeNotional = sized.preFeeNotional;
    feeBudget = sized.feeBudget;
    if (sized.notional === 0 && sized.reason) blockers.push(sized.reason);
  } else if (!kelly.ok || kelly.fraction === 0) {
    blockers.push('kelly-unset');
  } else if (Number.isFinite(config.freeCashUsd)) {
    notional = config.freeCashUsd * kelly.fraction;
  }
  if (!fixedMode && config.retest !== true) blockers.push('retest-unset');
  let fee = null;
  if (fixedMode) {
    fee = null;
  } else if (!entryQuote || !exitQuote) {
    blockers.push('fee-quote-missing');
  } else if (!fixedMode && !(notional > 0)) {
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
    preFeeNotional,
    feeBudget,
    sizeMode: fixedMode ? 'paper_fixed_fraction' : 'kelly',
    empirical: false,
    modeCannotLiveExecute: true,
    addsEnabled: config.retest === true,
    sizeReason: fixedMode ? (notional > 0 ? null : blockers[0] || null) : (blockers.includes('kelly-unset') ? 'kelly-undocumented' : null),
    fee,
    slippage,
    blockers,
    legacyFloor: 'superseded',
    legacyFloorActive: false,
  };
}
