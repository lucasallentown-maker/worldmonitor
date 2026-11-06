export const RISK_SPEC = Object.freeze({
  volumeRatioMax: 0.20,
  liquidityKeep: 0.60,
  hardStop: 0.65,
  checkMs: 5 * 60 * 1000,
  closePollMs: 30 * 1000,
});

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function volumeRatio(h6, h24) {
  if (!finitePositive(h6) || !finitePositive(h24)) {
    return { ok: false, reason: 'volume-ratio-unknown', ratio: null };
  }
  const base = h24 / 4;
  if (!Number.isFinite(base) || base <= 0) return { ok: false, reason: 'volume-ratio-unknown', ratio: null };
  return { ok: true, ratio: h6 / base, reason: null };
}

export function feeFloor(dollars, maxFeeRate) {
  if (!Number.isFinite(maxFeeRate) || maxFeeRate <= 0) return { ok: false, reason: 'fee-max-unconfigured' };
  if (!finitePositive(dollars)) return { ok: false, reason: 'fee-dollars-invalid' };
  const floor = Math.max(0.0045 * dollars, 0.95) / dollars;
  if (floor > maxFeeRate) return { ok: false, reason: 'fee-floor-above-configured-max', floor };
  return { ok: true, floor };
}

export function riskCheck(input) {
  if (!input?.config || input.config.volumeRatioMax !== RISK_SPEC.volumeRatioMax
    || input.config.liquidityKeep !== RISK_SPEC.liquidityKeep
    || input.config.hardStop !== RISK_SPEC.hardStop) {
    return { ok: false, reason: 'risk-config-incomplete', exit: false };
  }
  const ratio = volumeRatio(input.volumeH6, input.volumeH24);
  if (!ratio.ok) return { ok: false, reason: ratio.reason, exit: false };
  if (!finitePositive(input.entryLiquidity) || !finitePositive(input.liquidityUsd)) {
    return { ok: false, reason: 'liquidity-unknown', exit: false };
  }
  if (!finitePositive(input.entryPaperPrice) || !finitePositive(input.paperPrice)) {
    return { ok: false, reason: 'paper-price-unknown', exit: false };
  }
  const liquidityRatio = input.liquidityUsd / input.entryLiquidity;
  const priceRatio = input.paperPrice / input.entryPaperPrice;
  const exit = ratio.ratio < input.config.volumeRatioMax
    || liquidityRatio < input.config.liquidityKeep
    || priceRatio <= input.config.hardStop;
  return {
    ok: true,
    exit,
    ratio: ratio.ratio,
    liquidityRatio,
    priceRatio,
    paper: true,
    liveOrder: false,
  };
}

export function checkDue(lastAt, now, intervalMs) {
  if (!Number.isFinite(lastAt) || !Number.isFinite(now)) return { ok: false, reason: 'clock-unknown', due: false };
  return { ok: true, due: now - lastAt >= intervalMs };
}

export function heartbeat(lastBeat, now, intervalMs = 60_000) {
  if (!Number.isFinite(lastBeat) || !Number.isFinite(now)) return { ok: false, reason: 'heartbeat-unknown', stale: true };
  return { ok: true, stale: now - lastBeat > intervalMs };
}

export function paperEntry(order) {
  return { live: false, submitted: false, transport: null, interface: 'entry', order: order ?? null };
}

export function paperExit(order) {
  return { live: false, submitted: false, transport: null, interface: 'exit', order: order ?? null };
}
