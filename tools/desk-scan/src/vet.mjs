export const VET_WINDOWS_MS = Object.freeze({
  authority: 7 * 24 * 60 * 60 * 1000,
  topOwner: 7 * 24 * 60 * 60 * 1000,
  top10: 90 * 60 * 1000,
  holders: 90 * 60 * 1000,
  liqFeesPriced: 25 * 60 * 1000,
  story: 6 * 60 * 60 * 1000,
  cycle: 10 * 60 * 1000,
});

export const SOCIAL = Object.freeze({
  available: false,
  reason: 'social-unavailable',
  endpoint: null,
});

function ageOf(at, now) {
  if (!Number.isFinite(at)) return null;
  return now - at;
}

function fresh(at, now, windowMs) {
  const age = ageOf(at, now);
  return age != null && age >= -120_000 && age <= windowMs;
}

export function vetDossier(input, now) {
  const reasons = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, reasons: ['dossier-missing'], social: SOCIAL };
  }
  if (!fresh(input.cycleFinishedAt, now, VET_WINDOWS_MS.cycle)) reasons.push('vet-cycle-stale');

  for (const [field, setReason] of [['mintAuthority', 'mint-authority-set'], ['freezeAuthority', 'freeze-authority-set']]) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) reasons.push(`${field === 'mintAuthority' ? 'mint' : 'freeze'}-authority-unknown`);
    else if (input[field] !== null) reasons.push(setReason);
    else if (!fresh(input.authorityAt, now, VET_WINDOWS_MS.authority)) reasons.push('authority-stale');
  }

  const holders = input.holders;
  if (!holders || holders.complete !== true || !Number.isInteger(holders.count)) {
    reasons.push('holders-unknown');
  } else {
    if (!fresh(holders.at, now, VET_WINDOWS_MS.holders)) reasons.push('holders-stale');
    if (holders.count < 100) reasons.push('holders-below-100');
  }
  if (!holders || !Number.isFinite(holders.top1)) reasons.push('top-owner-unknown');
  else {
    if (!fresh(holders.at, now, VET_WINDOWS_MS.topOwner)) reasons.push('top-owner-stale');
    if (holders.top1 > 0.05) reasons.push('top-owner-above-5pct');
  }
  if (!holders || !Number.isFinite(holders.top10)) reasons.push('top10-unknown');
  else {
    if (!fresh(holders.at, now, VET_WINDOWS_MS.top10)) reasons.push('top10-stale');
    if (holders.top10 > 0.55) reasons.push('top10-above-55pct');
  }

  if (!Number.isFinite(input.liquidityUsd) || input.liquidityUsd < 0) reasons.push('liquidity-unknown');
  else if (!fresh(input.liquidityAt, now, VET_WINDOWS_MS.liqFeesPriced)) reasons.push('liquidity-stale');
  if (input.feesDocumented !== true) reasons.push('fees-undocumented');
  else if (!fresh(input.feesAt, now, VET_WINDOWS_MS.liqFeesPriced)) reasons.push('fees-stale');
  if (!Number.isFinite(input.price) || input.price <= 0) reasons.push('price-unknown');
  else if (!fresh(input.pricedAt, now, VET_WINDOWS_MS.liqFeesPriced)) reasons.push('price-stale');

  if (!input.story || typeof input.story.text !== 'string' || input.story.text.trim() === '') {
    reasons.push('story-missing');
  } else if (!fresh(input.story.at, now, VET_WINDOWS_MS.story)) {
    reasons.push('story-stale');
  }
  if (input.social && input.social.available === true) reasons.push('social-claim-rejected');

  return {
    ok: reasons.length === 0,
    reasons,
    social: SOCIAL,
    paper: true,
    liveOrder: false,
  };
}

export function recordHolderSnapshot(history, snap) {
  if (!snap || snap.complete !== true || !Number.isInteger(snap.holders) || snap.holders < 0 || !Number.isFinite(snap.at)) {
    return { ok: false, reason: 'snapshot-incomplete', history: history || [] };
  }
  const next = [...(history || []), snap].sort((a, b) => a.at - b.at);
  return { ok: true, history: next };
}

export function holderHistoryReady(history) {
  const rows = (history || []).filter((snap) => snap.complete === true);
  if (rows.length < 2) return { ok: false, reason: 'holder-history-missing' };
  const spanMs = rows.at(-1).at - rows[0].at;
  if (spanMs < 10 * 60 * 1000) return { ok: false, reason: 'holder-warmup-10m' };
  return { ok: true, spanMs, snapshots: rows.length };
}
