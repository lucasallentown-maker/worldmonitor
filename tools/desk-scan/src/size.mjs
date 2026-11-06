import { paperCost } from './costs.mjs';
import { feeGate } from './fomo-fees.mjs';

export function kellyFraction(edge) {
  if (!edge || !Number.isFinite(edge.probability) || !Number.isFinite(edge.payoff)) {
    return { ok: true, fraction: 0, reason: 'kelly-undocumented' };
  }
  if (edge.probability < 0 || edge.probability > 1 || edge.payoff <= 0) {
    return { ok: false, reason: 'kelly-malformed', fraction: null };
  }
  const fraction = edge.probability - ((1 - edge.probability) / edge.payoff);
  return { ok: true, fraction: Math.max(0, fraction), reason: null };
}

function configReady(config, requireScope) {
  if (!Number.isFinite(config?.slippageBps) || config.slippageBps < 0) return 'slippage-unconfigured';
  if (!Number.isFinite(config?.maxFeeRate) || config.maxFeeRate <= 0) return 'fee-max-unconfigured';
  if (requireScope && config?.maxFeeScope !== 'per-leg' && config?.maxFeeScope !== 'round-trip') return 'fee-scope-unconfigured';
  return null;
}

export function fixedFractionNotional({ bank, freeCash, liquidityUsd, fraction }) {
  if (!Number.isFinite(bank) || bank < 0) return { ok: false, reason: 'bank-unconfigured', notional: null };
  if (!Number.isFinite(freeCash) || freeCash < 0) return { ok: false, reason: 'free-cash-invalid', notional: null };
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return { ok: false, reason: 'fixed-fraction-invalid', notional: null };
  const target = bank * fraction;
  const bankCeiling = bank * 0.06;
  const liquidityCap = Number.isFinite(liquidityUsd) ? liquidityUsd * 0.02 : null;
  const caps = [target, freeCash, bankCeiling];
  if (liquidityCap != null) caps.push(liquidityCap);
  return {
    ok: true,
    mode: 'paper_fixed_fraction',
    empirical: false,
    adjustable: true,
    source: 'engineering-test-assumption',
    liveOrder: false,
    modeCannotLiveExecute: true,
    target,
    notional: Math.min(...caps),
    bankCeiling,
    freeCashCap: freeCash,
    liquidityCap,
    partial: false,
    sizeIncreased: false,
  };
}

export function feeBudgetNote(notionalUsd, maxFeeRate) {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0 || !Number.isFinite(maxFeeRate)) {
    return { assumedRoute: false, fabricatedFee: false, incompatibleWithPublishedLowFlat: null };
  }
  const roundTripBudgetUsd = notionalUsd * maxFeeRate;
  const publishedLowRouteFlatPerLegUsd = 0.1;
  const publishedTwoLegFlatUsd = 0.2;
  return {
    assumedRoute: false,
    fabricatedFee: false,
    sizeIncreased: false,
    roundTripBudgetUsd,
    publishedLowRouteFlatPerLegUsd,
    publishedTwoLegFlatUsd,
    incompatibleWithPublishedLowFlat: notionalUsd < 5 && roundTripBudgetUsd + 1e-9 < publishedTwoLegFlatUsd,
    note: 'The published under-5 dollar low-route flat is 0.10 per leg. Two such legs would be 0.20. This is not a quote and the route is not assumed. The size is not increased to make that flat fit.',
  };
}

export function sizePaper(input) {
  const requireScope = input?.config?.sizeMode === 'paper_fixed_fraction' || input?.requireFeeGate === true;
  const configError = configReady(input?.config, requireScope);
  if (configError) return { ok: false, reason: configError, notional: null, lockedCapital: input?.lockedCapital };
  if (!Number.isFinite(input.freeCash) || input.freeCash < 0) {
    return { ok: false, reason: 'free-cash-invalid', notional: null };
  }
  if (!Number.isFinite(input.lockedCapital) || input.lockedCapital < 0) {
    return { ok: false, reason: 'locked-capital-invalid', notional: null };
  }
  if (input.config?.sizeMode !== 'paper_fixed_fraction' && !Number.isFinite(input.realizedProfit)) {
    return { ok: false, reason: 'realized-profit-undocumented', notional: null, lockedCapital: input.lockedCapital };
  }
  if (input.config?.sizeMode !== 'paper_fixed_fraction' && (!Number.isFinite(input.liquidityUsd) || input.liquidityUsd < 0)) {
    return { ok: false, reason: 'liquidity-invalid', notional: null, lockedCapital: input.lockedCapital };
  }
  if (input.config?.sizeMode === 'paper_fixed_fraction' && input.liquidityUsd != null && (!Number.isFinite(input.liquidityUsd) || input.liquidityUsd < 0)) {
    return { ok: false, reason: 'liquidity-invalid', notional: null, lockedCapital: input.lockedCapital };
  }
  const addsEnabled = input.config?.retest === true;
  if (input.config?.sizeMode === 'paper_fixed_fraction') {
    const fixed = fixedFractionNotional({
      bank: input.bank,
      freeCash: input.freeCash,
      liquidityUsd: input.liquidityUsd,
      fraction: input.config.fixedFraction,
    });
    if (!fixed.ok) return { ...fixed, lockedCapital: input.lockedCapital, addsEnabled, liveOrder: false };
    const budget = feeBudgetNote(fixed.notional, input.config.maxFeeRate);
    const base = {
      mode: 'paper_fixed_fraction',
      empirical: false,
      adjustable: true,
      source: 'engineering-test-assumption',
      preFeeNotional: fixed.notional,
      partial: false,
      sizeIncreased: false,
      addsEnabled,
      retestBlocksEntry: false,
      lockedCapital: input.lockedCapital,
      lockedCapitalUnchanged: true,
      bankCeiling: fixed.bankCeiling,
      feeBudget: budget,
      paper: true,
      liveOrder: false,
      modeCannotLiveExecute: true,
    };
    if (!input.entryQuote || !input.exitQuote) {
      return { ...base, ok: false, reason: 'fee-quote-missing', notional: 0, fee: null };
    }
    const gate = feeGate({
      notionalUsd: fixed.notional,
      chain: input.chain,
      entry: input.entryQuote,
      exit: input.exitQuote,
      maxFeeRate: input.config.maxFeeRate,
      maxFeeScope: input.config.maxFeeScope,
      now: input.now,
      allowFixture: input.allowFixture === true,
    });
    if (!gate.pass || (!gate.suggest && input.allowFixture !== true)) {
      return { ...base, ok: false, reason: gate.reason, notional: 0, fee: gate };
    }
    return { ...base, ok: true, reason: null, notional: fixed.notional, fee: gate };
  }
  const kelly = kellyFraction(input.kelly);
  if (!kelly.ok) {
    return { ok: false, reason: kelly.reason, notional: null, lockedCapital: input.lockedCapital, addsEnabled, liveOrder: false };
  }
  if (!Number.isFinite(input.bank) || input.bank < 0) {
    return { ok: false, reason: 'bank-unconfigured', notional: null, lockedCapital: input.lockedCapital };
  }
  const ceiling = input.bank * 0.06;
  const freeCap = input.freeCash;
  const liqCap = input.liquidityUsd * 0.02;
  const cap = Math.min(ceiling, freeCap, liqCap);
  let notional = input.freeCash * kelly.fraction;
  let partial = false;
  if (notional > cap) {
    notional = cap * 0.5;
    partial = true;
  }
  const costs = Number.isFinite(input.config.feeBps)
    ? paperCost({ notionalUsd: notional, feeBps: input.config.feeBps, slippageBps: input.config.slippageBps })
    : null;
  if (input.requireFeeGate === true && notional > 0) {
    const gate = feeGate({
      notionalUsd: notional,
      chain: input.chain,
      entry: input.entryQuote,
      exit: input.exitQuote,
      maxFeeRate: input.config.maxFeeRate,
      maxFeeScope: input.config.maxFeeScope,
      now: input.now,
      allowFixture: input.allowFixture === true,
    });
    if (!gate.pass || (!gate.suggest && input.allowFixture !== true)) {
      return {
        ok: false,
        reason: gate.reason,
        notional: 0,
        partial: false,
        costs,
        fee: gate,
        lockedCapital: input.lockedCapital,
        lockedCapitalUnchanged: true,
        bankCeiling: ceiling,
        paper: true,
        liveOrder: false,
      };
    }
  }
  return {
    ok: true,
    mode: 'kelly',
    addsEnabled,
    retestBlocksEntry: false,
    reason: kelly.fraction === 0 ? 'kelly-undocumented' : null,
    notional,
    partial,
    costs,
    lockedCapital: input.lockedCapital,
    lockedCapitalUnchanged: true,
    reserveFromRealizedProfit: input.realizedProfit > 0 ? input.realizedProfit : 0,
    bankCeiling: ceiling,
    freeCashCap: freeCap,
    paper: true,
    liveOrder: false,
  };
}
