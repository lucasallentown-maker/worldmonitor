import { paperCost, paperQuote } from './costs.mjs';
import { validatePaperConfig } from './config.mjs';
import { sizePaper } from './size.mjs';
import { PAPER_INTERVALS_MS } from './timers.mjs';
import { SOCIAL } from './vet.mjs';

export function planExecutablePaper(config, quote = {}) {
  const checked = validatePaperConfig(config);
  const socialHandle = typeof config?.socialHandle === 'string' ? config.socialHandle.trim() : '';
  const social = socialHandle
    ? { ...SOCIAL, status: 'BLOCKED', reason: 'social-connector-unavailable', verifiedReads: null, handlePresent: true }
    : { available: false, status: 'PASS_PARTIAL', reason: 'no-handle', verifiedReads: null, endpoint: null, connector: 'blocked' };
  if (!checked.ok) {
    return {
      ok: false,
      sizeReady: false,
      notional: null,
      costs: null,
      quote: null,
      missing: checked.missing,
      decisions: checked.decisions,
      kellyUnset: checked.kellyUnset,
      reasons: checked.reasons,
      units: checked.units,
      bankDefaultApplied: false,
      prior200Authorized: false,
      timers: PAPER_INTERVALS_MS,
      timersStarted: false,
      social,
      liveOrder: false,
      pnl: null,
    };
  }
  const sized = sizePaper({
    freeCash: config.freeCashUsd,
    lockedCapital: config.lockedCapitalUsd,
    bank: checked.bankUsd,
    realizedProfit: config.realizedProfitUsd,
    liquidityUsd: config.liquidityUsd,
    kelly: config.kelly,
    config: {
      retest: config.retest,
      feeBps: config.feeBps,
      slippageBps: config.slippageBps,
      maxFeeRate: config.maxFeeRate,
    },
  });
  const quoted = paperQuote({ quotePrice: quote.quotePrice, slippageBps: config.slippageBps });
  const costs = sized.ok ? paperCost({
    notionalUsd: sized.notional,
    feeBps: config.feeBps,
    slippageBps: config.slippageBps,
  }) : null;
  return {
    ok: sized.ok === true,
    sizeReady: sized.ok === true && sized.notional > 0,
    reason: sized.reason || null,
    notional: sized.ok ? sized.notional : null,
    lockedCapital: sized.lockedCapital,
    costs,
    quote: quoted.ok ? quoted : null,
    missing: [],
    decisions: checked.decisions,
    kellyUnset: checked.kellyUnset,
    reasons: checked.reasons,
    units: checked.units,
    bankDefaultApplied: false,
    prior200Authorized: false,
    timers: PAPER_INTERVALS_MS,
    timersStarted: false,
    social,
    liveOrder: false,
    pnl: null,
  };
}
