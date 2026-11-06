// Observation only. Candidates and holder snapshots are stored. No size, no
// Kelly estimate, and no order.

import path from 'node:path';
import { atomicWriteJson, readJson, withLock } from './persist.mjs';
import { recordHolderSnapshot } from './vet.mjs';

export function emptyObservation() {
  return {
    schema: 'observation/v1',
    mode: 'observation',
    sizedPositions: false,
    liveOrder: false,
    kelly: null,
    pnl: null,
    records: {},
  };
}

function recordFor(state, contract) {
  if (!state.records[contract]) {
    state.records[contract] = {
      contract,
      prospective: true,
      firstSeenAt: null,
      lastSeenAt: null,
      ticker: null,
      liquidityUsd: null,
      liquiditySource: null,
      holderHistory: [],
      outcomes: [],
      sized: false,
      notional: null,
    };
  }
  return state.records[contract];
}

export function observeCandidates(state, { now, rows, source = 'observation' } = {}) {
  const next = state && state.schema === 'observation/v1' ? structuredClone(state) : emptyObservation();
  next.sizedPositions = false;
  next.liveOrder = false;
  next.kelly = null;
  next.pnl = null;
  const accepted = [];
  const rejected = [];
  if (!Number.isFinite(now)) return { ok: false, reason: 'clock-unknown', state: next, accepted, rejected };
  for (const row of rows || []) {
    if (!row || typeof row.contract !== 'string' || row.contract.trim() === '') {
      rejected.push({ reason: 'contract-missing' });
      continue;
    }
    const slot = recordFor(next, row.contract);
    if (slot.firstSeenAt == null) slot.firstSeenAt = now;
    slot.lastSeenAt = now;
    slot.prospective = row.prospective !== false;
    if (typeof row.ticker === 'string' && row.ticker.trim() !== '') slot.ticker = row.ticker.trim();
    if (row.liquidityUsd != null) {
      if (!Number.isFinite(row.liquidityUsd) || row.liquidityUsd < 0 || row.liquiditySource !== 'verified-candidate') {
        rejected.push({ contract: row.contract, reason: 'liquidity-not-from-candidate' });
        continue;
      }
      const previousLiquidity = slot.liquidityUsd;
      slot.liquidityUsd = row.liquidityUsd;
      slot.liquiditySource = 'verified-candidate';
      if (previousLiquidity != null && previousLiquidity !== row.liquidityUsd) {
        slot.outcomes.push({
          at: now,
          kind: 'liquidity',
          from: previousLiquidity,
          to: row.liquidityUsd,
          sized: false,
          notional: null,
          pnl: null,
          source,
        });
      }
    }
    if (row.price != null) {
      if (!Number.isFinite(row.price) || row.price <= 0) {
        rejected.push({ contract: row.contract, reason: 'price-invalid' });
        continue;
      }
      const previous = slot.outcomes.filter((item) => item.kind === 'price').at(-1);
      if (previous && previous.to !== row.price) {
        slot.outcomes.push({
          at: now,
          kind: 'price',
          from: previous.to,
          to: row.price,
          sized: false,
          notional: null,
          pnl: null,
          source,
        });
      } else if (!previous) {
        slot.outcomes.push({
          at: now,
          kind: 'price',
          from: null,
          to: row.price,
          sized: false,
          notional: null,
          pnl: null,
          source,
        });
      }
    }
    if (row.holders != null || row.holderComplete != null) {
      const snap = recordHolderSnapshot(slot.holderHistory, {
        at: now,
        holders: row.holders,
        complete: row.holderComplete === true,
      });
      if (!snap.ok) rejected.push({ contract: row.contract, reason: snap.reason });
      else slot.holderHistory = snap.history;
    }
    slot.sized = false;
    slot.notional = null;
    accepted.push(row.contract);
  }
  return { ok: true, state: next, accepted, rejected, sizedPositions: false, liveOrder: false };
}

export function rowsFromScan(report) {
  const rows = [];
  for (const candidate of report?.candidates || []) {
    rows.push({
      contract: candidate.contract,
      ticker: candidate.ticker,
      liquidityUsd: candidate.liquidity_usd,
      liquiditySource: Number.isFinite(candidate.liquidity_usd) ? 'verified-candidate' : null,
      price: Number.isFinite(candidate.price) ? candidate.price : null,
      holders: Number.isInteger(candidate.holders) ? candidate.holders : null,
      holderComplete: candidate.holderComplete === true,
      prospective: false,
    });
  }
  const probe = report?.holderProbe;
  if (probe?.mint) {
    rows.push({
      contract: probe.mint,
      holders: probe.holderCount,
      holderComplete: probe.ok === true && Number.isInteger(probe.holderCount),
      prospective: true,
      liquidityUsd: null,
    });
  }
  return rows;
}

export async function persistObservation(dir, state) {
  const file = path.join(dir, 'observation.json');
  return withLock(path.join(dir, 'observation.lock'), async () => {
    atomicWriteJson(file, state);
    return file;
  });
}

export function loadObservation(dir) {
  return readJson(path.join(dir, 'observation.json'), emptyObservation());
}
