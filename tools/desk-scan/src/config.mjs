// Paper settings checklist. Null stays null. A prior 200 dollar balance is not
// loaded as a default.

export const PAPER_UNITS = Object.freeze({
  bankUsd: 'dollars',
  freeCashUsd: 'dollars',
  lockedCapitalUsd: 'dollars',
  realizedProfitUsd: 'dollars',
  liquidityUsd: 'dollars',
  feeBps: 'basis-points-of-notional',
  slippageBps: 'basis-points-of-notional',
  maxFeeRate: 'fraction-of-notional',
  retest: 'true-only-if-you-require-it',
  'kelly.probability': 'probability-from-0-to-1',
  'kelly.payoff': 'payoff-ratio',
  socialHandle: 'text-or-null',
});

const REQUIRED = ['bankUsd', 'freeCashUsd', 'lockedCapitalUsd', 'realizedProfitUsd', 'liquidityUsd', 'feeBps', 'slippageBps', 'maxFeeRate', 'retest'];

function present(value) {
  return value !== null && value !== undefined && value !== '';
}

export function validatePaperConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  const missing = REQUIRED.filter((key) => !present(source[key]));
  const kelly = source.kelly && typeof source.kelly === 'object' ? source.kelly : {};
  const kellyUnset = !present(kelly.probability) || !present(kelly.payoff);
  const prior200 = source.bankUsd === 200 && source.bankUsdSource !== 'user-entered';
  const reasons = [];
  if (prior200) reasons.push('prior-desk-200-not-authorized-as-default');
  return {
    ok: missing.length === 0 && !prior200,
    missing,
    decisions: kellyUnset ? ['kelly.probability', 'kelly.payoff'] : [],
    kellyUnset,
    reasons,
    units: PAPER_UNITS,
    bankUsd: prior200 ? null : (present(source.bankUsd) ? source.bankUsd : null),
    bankDefaultApplied: false,
    prior200Authorized: false,
    falseData: false,
    liveOrder: false,
  };
}
