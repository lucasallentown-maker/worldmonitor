// Paper settings checklist. Null stays null. A prior 200 dollar balance is not
// loaded as a default.

export const PAPER_UNITS = Object.freeze({
  bankUsd: 'dollars',
  freeCashUsd: 'dollars',
  lockedCapitalUsd: 'dollars',
  realizedProfitUsd: 'dollars-derived-from-ledger',
  initialRealizedProfitUsd: 'dollars-unknown-starting-balance',
  liquidityUsd: 'dollars-from-verified-candidate',
  feeBps: 'basis-points-of-notional',
  slippageBps: 'basis-points-of-notional',
  maxFeeRate: 'fraction-of-notional',
  maxFeeScope: 'per-leg-or-round-trip',
  retest: 'adds-only-until-you-define-one',
  sizeMode: 'paper_fixed_fraction-or-kelly',
  fixedFraction: 'fraction-of-current-paper-bank',
  'kelly.probability': 'probability-from-0-to-1',
  'kelly.payoff': 'payoff-ratio',
  socialHandle: 'text-or-null',
});

const REQUIRED = ['bankUsd', 'freeCashUsd', 'lockedCapitalUsd', 'slippageBps', 'maxFeeRate', 'maxFeeScope'];

export const CONFIG_ROLES = Object.freeze({
  userInput: ['bankUsd', 'freeCashUsd', 'lockedCapitalUsd', 'initialRealizedProfitUsd', 'feeBps', 'slippageBps', 'maxFeeRate', 'retest', 'socialHandle', 'socialEvidence'],
  derived: ['realizedProfitUsd'],
  verifiedCandidate: ['liquidityUsd'],
  externalService: ['fred', 'geckoterminal', 'solanaRpc', 'public-x-tool'],
  unsetUntilHistory: ['kelly.probability', 'kelly.payoff'],
});

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
  if (present(source.liquidityUsd)) reasons.push('liquidity-not-a-user-input');
  if (present(source.realizedProfitUsd)) reasons.push('realized-profit-must-come-from-ledger');
  if (present(source.initialRealizedProfitUsd) && source.initialRealizedProfitSource !== 'user-entered') {
    reasons.push('initial-realized-source-missing');
  }
  const freeSet = present(source.freeCashUsd);
  const lockedSet = present(source.lockedCapitalUsd);
  if (freeSet !== lockedSet) reasons.push('cash-split-incomplete');
  if (freeSet && lockedSet && present(source.bankUsd) && !prior200) {
    if (Math.abs((source.freeCashUsd + source.lockedCapitalUsd) - source.bankUsd) > 1e-6) {
      reasons.push('cash-split-does-not-match-bank');
    }
  }
  const venueFeeUnset = !present(source.maxFeeRate) || !present(source.maxFeeScope);
  return {
    ok: missing.length === 0 && reasons.length === 0,
    missing,
    decisions: kellyUnset ? ['kelly.probability', 'kelly.payoff'] : [],
    kellyUnset,
    reasons,
    units: PAPER_UNITS,
    bankUsd: prior200 ? null : (present(source.bankUsd) ? source.bankUsd : null),
    bankCeilingUsd: !prior200 && Number.isFinite(source.bankUsd) ? source.bankUsd * 0.06 : null,
    ceilingIsTarget: false,
    paperOnly: true,
    liveDeposit: false,
    liveAuthorization: false,
    venueFee: venueFeeUnset ? 'external-quote-required' : 'cutoff-set-quote-still-required',
    bankDefaultApplied: false,
    prior200Authorized: false,
    falseData: false,
    liveOrder: false,
    roles: CONFIG_ROLES,
  };
}

export function configGuide() {
  return [
    'Paper config guide. Null means unset. Nothing here is a fill.',
    'Paper initial bank: bankUsd 200 with bankUsdSource user-entered is the paper bank you named. It is not a deposit and not a live authorization. Six percent of 200 is a 12 dollar ceiling, not an order target.',
    'User choice, dollars: freeCashUsd and lockedCapitalUsd together. They must add up to bankUsd. One side cannot be guessed from the other. Locked capital is not spendable.',
    'A fresh empty journal has paper profit 0. That 0 is not a real-money profit claim. A close without pnl stays unknown and is not stored as zero. initialRealizedProfitUsd is only for a starting balance you type, with initialRealizedProfitSource user-entered.',
    'Venue is fomo.family. A displayed buy quote and a displayed sell quote are both required. Each quote needs feeUsd, notionalUsd, chain, side, timestamp, and provenance. A missing, stale, mismatched, or unverifiable quote blocks the suggestion. An entry quote does not prove the exit fee.',
    'Selected paper file: maxFeeRate 0.04 means buy fee plus sell fee at most 4 percent of the entry notional. maxFeeScope is round-trip. That 0.04 is not a per-leg cap. slippageBps 100 is 1 percent adverse price on each side, simulated, and separate from the fee cap.',
    'The published Solana low-route schedule is a scenario, not a quote. The old floor max(0.0045 * dollars, 0.95) is superseded for paper sizing. It is not an active conflict. A verified buy plus sell at or under 4 percent of the entry notional passes.',
    'Referral 0.50 percent to 0.45 percent applies only when that standard rate is the one in force and the quote says the referral is verified. Fixed Solana bands and the 0.05 percent major rate are not discounted. The major minimum is not published.',
    'slippageBps, if you set it, is basis points of notional (1 bp = 0.0001). It is not a venue fee and it is not guessed.',
    'Selected paper mode is paper_fixed_fraction. fixedFraction 0.01 is an engineering test assumption: 1 percent of the current paper bank, initially 2 dollars. It is not a Kelly probability or payoff. You can change the fraction. Kelly remains available only as sizeMode kelly and stays at 0 until you enter both inputs.',
    'retest does not block the first entry. Adds stay off until you define a measurable retest.',
    'Not a user input: liquidityUsd. It must come from a verified candidate.',
    'Social: socialHandle optional. No handle is PASS_PARTIAL. A handle waits for a public-x-tool evidence file. This process does not call X.',
    'External services, not typed here: FRED, GeckoTerminal, Solana RPC, and the public X tool that produces evidence.',
    'Observation mode does not size a position.',
  ].join('\n');
}
