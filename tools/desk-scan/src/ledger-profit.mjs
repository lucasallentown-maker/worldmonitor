// Running profit comes from the journal. A user may enter only the unknown
// starting balance. A missing close P&L stays unknown and is not stored as zero.

export function deriveRealizedProfit(ledger, initial) {
  const events = Array.isArray(ledger?.events) ? ledger.events : [];
  const closes = events.filter((row) => row?.type === 'paper-close' && row.confirmed === true);
  if (closes.some((row) => !Number.isFinite(row.pnl))) {
    return { ok: false, usd: null, source: 'ledger', reason: 'ledger-pnl-unknown' };
  }
  const fromLedger = closes.reduce((sum, row) => sum + row.pnl, 0);
  if (!Number.isFinite(initial)) {
    if (closes.length === 0) {
      return { ok: true, usd: 0, source: 'fresh-ledger', realMoneyClaim: false, reason: null };
    }
    return { ok: true, usd: fromLedger, source: 'ledger', realMoneyClaim: false, reason: null };
  }
  return {
    ok: true,
    usd: initial + fromLedger,
    source: closes.length === 0 ? 'user-initial' : 'initial-plus-ledger',
    realMoneyClaim: false,
    reason: null,
  };
}
