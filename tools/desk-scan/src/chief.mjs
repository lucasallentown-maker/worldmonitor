const HOUR_MS = 60 * 60 * 1000;

export function supervise(input) {
  const now = input?.now;
  if (!Number.isFinite(now)) {
    return { ok: false, reason: 'clock-unknown', ready: false, humanWatch: false, stopNewEntries: true };
  }
  const failures = Array.isArray(input.failures) ? input.failures.filter((at) => Number.isFinite(at) && now - at <= HOUR_MS && now - at >= 0) : null;
  if (!failures) {
    return { ok: false, reason: 'failures-unknown', ready: false, humanWatch: false, stopNewEntries: true };
  }
  const due = !Number.isFinite(input.lastSupervisionAt) || now - input.lastSupervisionAt >= 60_000;
  const risk = input.risk;
  if (!risk || risk.ok !== true) {
    return {
      ok: false,
      reason: 'risk-monitor-unavailable',
      ready: false,
      humanWatch: false,
      stopNewEntries: true,
      supervisionDue: due,
    };
  }
  return {
    ok: true,
    ready: false,
    status: 'NOT_READY',
    humanWatch: false,
    supervisionDue: due,
    stopNewEntries: failures.length >= 2,
    failuresInHour: failures.length,
    riskExit: risk.exit === true,
    reason: failures.length >= 2 ? 'two-failures-in-hour' : 'desk-incomplete',
    vet: 'paper',
    size: 'paper',
    fills: 'paper',
    risk: 'paper',
    liveOrder: false,
  };
}
