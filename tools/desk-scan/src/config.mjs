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
  retest: 'true-only-if-you-require-it',
  'kelly.probability': 'probability-from-0-to-1',
  'kelly.payoff': 'payoff-ratio',
  socialHandle: 'text-or-null',
});

const REQUIRED = ['bankUsd', 'freeCashUsd', 'lockedCapitalUsd', 'slippageBps', 'maxFeeRate', 'maxFeeScope', 'retest'];

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
    'maxFeeRate is a fraction of notional. maxFeeScope is per-leg or round-trip. Leave both null and suggestions stay blocked. There is no default cutoff.',
    'The published Solana low-route schedule is a scenario, not a quote. At the 12 dollar ceiling that scenario is 0.24 dollars. The separate user guard max(0.0045 * dollars, 0.95) is 0.95 dollars at that size. Those two figures conflict. The guard is not removed, and it is not the venue schedule.',
    'Referral 0.50 percent to 0.45 percent applies only when that standard rate is the one in force and the quote says the referral is verified. Fixed Solana bands and the 0.05 percent major rate are not discounted. The major minimum is not published.',
    'slippageBps, if you set it, is basis points of notional (1 bp = 0.0001). It is not a venue fee and it is not guessed.',
    'User input, boolean: retest true only if you require a retest.',
    'Not a user input: liquidityUsd. It must come from a verified candidate.',
    'Not a user input yet: kelly.probability and kelly.payoff. Leave null. Size stays 0 until paper history exists.',
    'Social: socialHandle optional. No handle is PASS_PARTIAL. A handle waits for a public-x-tool evidence file. This process does not call X.',
    'External services, not typed here: FRED, GeckoTerminal, Solana RPC, and the public X tool that produces evidence.',
    'Observation mode does not size a position.',
  ].join('\n');
}
