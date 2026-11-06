function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function emptyLedger() {
  return {
    schema: 'paper-ledger/v1',
    label: 'PAPER — not a live fill',
    liveFill: false,
    positions: {},
    events: [],
  };
}

function event(type, fields) {
  return { type, paper: true, liveFill: false, pnl: null, ...fields };
}

export function paperOpen(ledger, intent) {
  const next = clone(ledger || emptyLedger());
  if (!intent || typeof intent.intentId !== 'string' || intent.intentId === '') {
    return { ok: false, reason: 'intent-id-missing', ledger: next };
  }
  if (!Number.isFinite(intent.paperPrice) || intent.paperPrice <= 0 || !Number.isFinite(intent.qty) || intent.qty <= 0) {
    return { ok: false, reason: 'paper-order-invalid', ledger: next };
  }
  const existing = next.positions[intent.intentId];
  if (existing) return { ok: true, idempotent: true, deleted: false, position: existing, ledger: next };
  const position = {
    id: intent.intentId,
    label: 'PAPER',
    liveFill: false,
    contract: intent.contract,
    qty: intent.qty,
    paperPrice: intent.paperPrice,
    status: 'open',
    openedAt: intent.at,
  };
  next.positions[intent.intentId] = position;
  next.events.push(event('paper-open', {
    id: intent.intentId,
    contract: intent.contract,
    qty: intent.qty,
    paperPrice: intent.paperPrice,
    at: intent.at,
    provenance: intent.provenance || 'fixture',
  }));
  return { ok: true, idempotent: false, deleted: false, position, ledger: next };
}

export function paperClose(ledger, close) {
  const next = clone(ledger || emptyLedger());
  const position = next.positions[close?.id];
  if (!position) return { ok: false, reason: 'position-missing', deleted: false, ledger: next };
  if (close.confirmed !== true) {
    position.status = 'closing';
    next.events.push(event('paper-close-requested', { id: close.id, at: close.at, confirmed: false }));
    return { ok: true, deleted: false, ledger: next };
  }
  if (!Number.isFinite(close.paperPrice) || close.paperPrice <= 0) {
    return { ok: false, reason: 'paper-exit-price-missing', deleted: false, ledger: next };
  }
  next.events.push(event('paper-close', {
    id: close.id,
    paperPrice: close.paperPrice,
    at: close.at,
    confirmed: true,
    provenance: close.provenance || 'fixture',
  }));
  const confirmed = next.events.some((row) => row.type === 'paper-close' && row.id === close.id && row.confirmed === true);
  if (!confirmed) return { ok: false, reason: 'close-not-journaled', deleted: false, ledger: next };
  delete next.positions[close.id];
  return { ok: true, deleted: true, ledger: next };
}

export function recoverLedger(journalEvents) {
  const ledger = emptyLedger();
  ledger.events = clone(journalEvents || []);
  for (const row of ledger.events) {
    if (row?.type === 'paper-open' && row.id && !ledger.positions[row.id]) {
      ledger.positions[row.id] = {
        id: row.id,
        label: 'PAPER',
        liveFill: false,
        contract: row.contract,
        qty: row.qty,
        paperPrice: row.paperPrice,
        status: 'open',
        openedAt: row.at,
      };
    }
  }
  for (const row of ledger.events) {
    if (row?.type === 'paper-close' && row.confirmed === true && row.id) delete ledger.positions[row.id];
    if (row?.type === 'paper-close-requested' && ledger.positions[row.id]) ledger.positions[row.id].status = 'closing';
  }
  return ledger;
}
