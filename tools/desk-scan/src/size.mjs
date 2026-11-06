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

function configReady(config) {
  if (!config || config.retest !== true) return 'retest-unconfigured';
  if (!Number.isFinite(config.slippageBps) || config.slippageBps < 0) return 'slippage-unconfigured';
  if (!Number.isFinite(config.maxFeeRate) || config.maxFeeRate <= 0) return 'fee-max-unconfigured';
  return null;
}

export function sizePaper(input) {
  const configError = configReady(input?.config);
  if (configError) return { ok: false, reason: configError, notional: null, lockedCapital: input?.lockedCapital };
  if (!Number.isFinite(input.freeCash) || input.freeCash < 0) {
    return { ok: false, reason: 'free-cash-invalid', notional: null };
  }
  if (!Number.isFinite(input.lockedCapital) || input.lockedCapital < 0) {
    return { ok: false, reason: 'locked-capital-invalid', notional: null };
  }
  if (!Number.isFinite(input.realizedProfit)) {
    return { ok: false, reason: 'realized-profit-undocumented', notional: null, lockedCapital: input.lockedCapital };
  }
  if (!Number.isFinite(input.liquidityUsd) || input.liquidityUsd < 0) {
    return { ok: false, reason: 'liquidity-invalid', notional: null, lockedCapital: input.lockedCapital };
  }
  const kelly = kellyFraction(input.kelly);
  if (!kelly.ok) {
    return { ok: false, reason: kelly.reason, notional: null, lockedCapital: input.lockedCapital };
  }
  const dollars = input.freeCash;
  if (input.requireFeeGate !== true) {
    const floor = Math.max(0.0045 * dollars, 0.95) / (dollars || NaN);
    if (!Number.isFinite(floor)) return { ok: false, reason: 'fee-dollars-invalid', notional: null, lockedCapital: input.lockedCapital };
    if (floor > input.config.maxFeeRate) {
      return { ok: false, reason: 'fee-floor-above-configured-max', floor, notional: null, lockedCapital: input.lockedCapital };
    }
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
    if (!gate.pass || !gate.suggest) {
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
