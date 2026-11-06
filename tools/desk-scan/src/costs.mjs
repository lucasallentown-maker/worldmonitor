// Paper quote and cost arithmetic. Rates come only from the caller.
// 1 basis point = 0.0001 of the paper notional. No venue fee schedule is applied.

const BPS = 10_000;

export function paperQuote(input) {
  const quotePrice = input?.quotePrice;
  if (!Number.isFinite(quotePrice) || quotePrice <= 0) {
    return { ok: false, reason: 'quote-missing', quotePrice: null, paperPrice: null };
  }
  if (!Number.isFinite(input.slippageBps)) {
    return { ok: false, reason: 'slippage-unconfigured', quotePrice, paperPrice: null };
  }
  if (input.slippageBps < 0) {
    return { ok: false, reason: 'slippage-invalid', quotePrice, paperPrice: null };
  }
  const side = input.side === 'sell' ? 'sell' : 'buy';
  const factor = input.slippageBps / BPS;
  const paperPrice = side === 'sell' ? quotePrice * (1 - factor) : quotePrice * (1 + factor);
  return {
    ok: true,
    quotePrice,
    side,
    slippageBps: input.slippageBps,
    slippageScope: 'per-side',
    paperPrice,
    simulated: true,
    executionPromised: false,
    separateFromFeeCap: true,
    unit: 'dollars-per-unit',
    paper: true,
    liveFill: false,
  };
}

export function paperCost(input) {
  const notionalUsd = input?.notionalUsd;
  if (!Number.isFinite(notionalUsd) || notionalUsd < 0) {
    return { ok: false, reason: 'notional-missing', feeUsd: null, slippageUsd: null, totalUsd: null };
  }
  if (!Number.isFinite(input.feeBps) || input.feeBps < 0) {
    return { ok: false, reason: 'fee-unconfigured', feeUsd: null, slippageUsd: null, totalUsd: null };
  }
  if (!Number.isFinite(input.slippageBps) || input.slippageBps < 0) {
    return { ok: false, reason: 'slippage-unconfigured', feeUsd: null, slippageUsd: null, totalUsd: null };
  }
  const feeUsd = notionalUsd * input.feeBps / BPS;
  const slippageUsd = notionalUsd * input.slippageBps / BPS;
  return {
    ok: true,
    paper: true,
    liveFill: false,
    pnl: null,
    venueSchedule: null,
    unit: {
      feeBps: 'basis-points-of-notional',
      slippageBps: 'basis-points-of-notional',
      usd: 'dollars',
    },
    feeBps: input.feeBps,
    slippageBps: input.slippageBps,
    feeUsd,
    slippageUsd,
    totalUsd: feeUsd + slippageUsd,
  };
}
