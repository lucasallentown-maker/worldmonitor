import { scanCycle } from './scan.mjs';
import { vetDossier } from './vet.mjs';
import { sizePaper } from './size.mjs';
import { paperEntry, paperExit, riskCheck } from './risk.mjs';
import { emptyLedger, paperClose, paperOpen, recoverLedger } from './paper-ledger.mjs';
import { supervise } from './chief.mjs';

export function runPaperFixture(input) {
  const scanned = scanCycle(input.scan);
  const candidate = scanned.candidates[0] || null;
  if (!candidate) return { ok: false, stage: 'scan', scanned, ledger: emptyLedger() };
  const vet = vetDossier(input.vet, input.now);
  if (!vet.ok) return { ok: false, stage: 'vet', vet, scanned, ledger: emptyLedger() };
  const sized = sizePaper(input.size);
  if (!sized.ok || !(sized.notional > 0)) return { ok: false, stage: 'size', sized, vet, scanned, ledger: emptyLedger() };
  const entry = paperEntry({ contract: candidate.contract, notional: sized.notional });
  let opened = paperOpen(emptyLedger(), {
    intentId: input.intentId,
    contract: candidate.contract,
    qty: sized.notional,
    paperPrice: input.entryPaperPrice,
    at: input.now,
    provenance: 'paper-fixture',
  });
  const replay = paperOpen(opened.ledger, {
    intentId: input.intentId,
    contract: candidate.contract,
    qty: sized.notional,
    paperPrice: input.entryPaperPrice,
    at: input.now,
  });
  const risk = riskCheck(input.risk);
  const exit = paperExit({ id: input.intentId });
  const requested = paperClose(opened.ledger, { id: input.intentId, at: input.now + 1, confirmed: false });
  const closed = paperClose(requested.ledger, {
    id: input.intentId,
    at: input.now + 2,
    paperPrice: input.exitPaperPrice,
    confirmed: true,
    provenance: 'paper-fixture',
  });
  const recovered = recoverLedger(closed.ledger.events);
  const chief = supervise({
    now: input.now,
    lastSupervisionAt: input.now - 60_000,
    failures: input.failures || [],
    risk,
  });
  return {
    ok: closed.ok && closed.deleted && replay.idempotent && entry.live === false && exit.live === false && chief.humanWatch === false,
    stage: 'closed',
    scanned,
    vet,
    sized,
    entry,
    opened,
    replay,
    risk,
    exit,
    requested,
    closed,
    recovered,
    chief,
    ledger: closed.ledger,
  };
}
