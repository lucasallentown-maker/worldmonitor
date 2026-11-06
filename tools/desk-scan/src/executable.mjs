import { paperCost, paperQuote } from './costs.mjs';
import { validatePaperConfig } from './config.mjs';
import { deriveRealizedProfit } from './ledger-profit.mjs';
import { sizePaper } from './size.mjs';
import { ingestSocialEvidence } from './social-evidence.mjs';
import { ceilingScenario } from './fomo-fees.mjs';
import { PAPER_INTERVALS_MS } from './timers.mjs';

export function planExecutablePaper(config, quote = {}, context = {}) {
  const checked = validatePaperConfig(config);
  const social = ingestSocialEvidence({
    handle: config?.socialHandle,
    evidence: config?.socialEvidence ?? null,
    now: context.now,
  });
  const scenario = ceilingScenario(checked.bankUsd);
  const roundTripBudgetUsd = Number.isFinite(checked.bankCeilingUsd) && Number.isFinite(config?.maxFeeRate)
    ? checked.bankCeilingUsd * config.maxFeeRate
    : null;
  const readiness = {
    bankUsd: checked.bankUsd,
    freeCashUsd: Number.isFinite(config?.freeCashUsd) ? config.freeCashUsd : null,
    lockedCapitalUsd: Number.isFinite(config?.lockedCapitalUsd) ? config.lockedCapitalUsd : null,
    maxFeeRate: Number.isFinite(config?.maxFeeRate) ? config.maxFeeRate : null,
    maxFeeScope: config?.maxFeeScope ?? null,
    maxFeeBasis: config?.maxFeeScope === 'round-trip' ? 'entry-notional' : null,
    slippageBps: Number.isFinite(config?.slippageBps) ? config.slippageBps : null,
    slippageScope: Number.isFinite(config?.slippageBps) ? 'per-side' : null,
    slippageSimulated: Number.isFinite(config?.slippageBps),
    executionPromised: false,
    retest: config?.retest === true ? 'set' : 'unset',
    kelly: checked.kellyUnset ? 'unset' : 'set',
    quotes: 'blocked-until-supplied',
    legacyFloor: 'superseded',
    legacyFloorActive: false,
    guardUsdAtCeiling: scenario.userGuardUsd,
    roundTripBudgetUsdAtCeiling: roundTripBudgetUsd,
    size: checked.kellyUnset ? 0 : null,
    liveOrder: false,
  };
  const bankView = {
    bankUsd: checked.bankUsd,
    bankCeilingUsd: checked.bankCeilingUsd,
    ceilingIsTarget: false,
    paperOnly: true,
    liveDeposit: false,
    liveAuthorization: false,
    venueFee: checked.venueFee,
    bankDefaultApplied: false,
    feeScenario: scenario,
    readiness,
  };
  if (!checked.ok) {
    return {
      ok: false,
      sizeReady: false,
      notional: checked.kellyUnset ? 0 : null,
      costs: null,
      quote: null,
      missing: checked.missing,
      decisions: checked.decisions,
      kellyUnset: checked.kellyUnset,
      reasons: checked.reasons,
      units: checked.units,
      ...bankView,
      timers: PAPER_INTERVALS_MS,
      timersStarted: false,
      social,
      liveOrder: false,
      pnl: null,
      realizedRealMoneyClaim: false,
    };
  }
  const realized = deriveRealizedProfit(context.ledger, config.initialRealizedProfitUsd);
  const candidateLiquidity = context.candidate?.liquidityUsd;
  if (!realized.ok || !Number.isFinite(candidateLiquidity) || context.candidate?.liquiditySource !== 'verified-candidate') {
    return {
      ok: false,
      sizeReady: false,
      notional: null,
      costs: null,
      quote: null,
      missing: checked.missing,
      decisions: checked.decisions,
      kellyUnset: checked.kellyUnset,
      reasons: [...checked.reasons, realized.ok ? 'liquidity-not-from-candidate' : realized.reason],
      units: checked.units,
      roles: checked.roles,
      ...bankView,
      timers: PAPER_INTERVALS_MS,
      timersStarted: false,
      social,
      realized,
      liveOrder: false,
      pnl: null,
    };
  }
  const sized = sizePaper({
    freeCash: config.freeCashUsd,
    lockedCapital: config.lockedCapitalUsd,
    bank: checked.bankUsd,
    realizedProfit: realized.usd,
    liquidityUsd: candidateLiquidity,
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
    ...bankView,
    realizedRealMoneyClaim: realized.realMoneyClaim === true,
    timers: PAPER_INTERVALS_MS,
    timersStarted: false,
    social,
    liveOrder: false,
    pnl: null,
  };
}
