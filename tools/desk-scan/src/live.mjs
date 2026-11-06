import path from 'node:path';
import { existsSync } from 'node:fs';
import { discoverNewPools, enrichPoolTrades, redactUrl } from './geckoterminal.mjs';
import { cheapFilter, planDexEnrich } from './rules.mjs';
import { readHolderSnapshot, redactRpc, resolveSolanaRpc } from './solana-holders.mjs';
import { atomicWriteJson, cycleFresh, readJson, withLock, CYCLE_MAX_AGE_MS } from './persist.mjs';
import { scanCycle } from './scan.mjs';

function emptyBudget() {
  return { calls: [], pausedUntil: 0 };
}

export async function runPaperScan({
  stateDir,
  now = Date.now(),
  fetchImpl = fetch,
  rpcUrl,
  wmSufficient = 0,
  probe = true,
} = {}) {
  const dir = stateDir;
  const lockFile = path.join(dir, 'scan.lock');
  return withLock(lockFile, async () => {
    const positionFile = path.join(dir, 'position.json');
    const position = existsSync(positionFile) ? readJson(positionFile) : null;
    if (position && typeof position === 'object') {
      const stopped = {
        schema: 'desk-scan/v1',
        live: true,
        fixture: false,
        paper: true,
        stopped: true,
        reason: 'position.json present; scanning stopped',
        candidates: [],
        finishedAt: new Date(now).toISOString(),
        fresh: true,
        chief: { ready: false, status: 'NOT_READY', reason: 'position.json present' },
      };
      atomicWriteJson(path.join(dir, 'scan.json'), stopped);
      return stopped;
    }

    const budgetFile = path.join(dir, 'gt-budget.json');
    let budget = readJson(budgetFile, emptyBudget());
    const bench = readJson(path.join(dir, 'bench.json'), {});
    const startedAt = now;
    const discovered = await discoverNewPools({ fetchImpl, state: budget, startedAt });
    budget = discovered.state || budget;
    atomicWriteJson(budgetFile, budget);

    const pools = discovered.pools || [];
    let tradesProbe = null;
    if (probe && discovered.ok) {
      const sample = [...pools].filter((pool) => pool.poolAddress).sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0))[0];
      if (sample) {
        const enriched = await enrichPoolTrades(sample.poolAddress, { fetchImpl, state: budget });
        budget = enriched.state || budget;
        atomicWriteJson(budgetFile, budget);
        tradesProbe = {
          pool: sample.poolAddress,
          mint: sample.contract,
          passedCheapFilter: cheapFilter(sample, startedAt).ok,
          ok: enriched.ok,
          reason: enriched.reason,
          parsedTrades: enriched.trades?.length ?? 0,
          observationComplete: enriched.observation?.complete === true,
          candidate: false,
        };
      }
    }

    const rpc = rpcUrl ? { url: rpcUrl, source: 'argument' } : resolveSolanaRpc();
    let holderProbe = null;
    const probeMint = tradesProbe?.mint || pools.find((pool) => pool.contract)?.contract;
    if (probe && probeMint) {
      const snap = await readHolderSnapshot(probeMint, { rpcUrl: rpc.url, fetchImpl });
      holderProbe = {
        mint: probeMint,
        rpc: redactRpc(rpc.url),
        rpcSource: rpc.source,
        ok: false,
        reason: snap.reason,
        holderCount: null,
        invented: false,
        persistedSnapshot: false,
        programs: (snap.programs || []).map((row) => ({ program: row.program, ok: row.ok, accounts: row.accounts ?? null, error: row.error ?? null })),
        topOwnerAbove5: snap.ok ? snap.topOwnerAbove5 : null,
        top10Above55: snap.ok ? snap.top10Above55 : null,
      };
      if (snap.ok && snap.freezeAuthority === null && Number.isInteger(snap.holderCount)) {
        holderProbe.ok = true;
        holderProbe.reason = null;
        holderProbe.holderCount = snap.holderCount;
        holderProbe.freezeAuthority = 'null';
      } else if (snap.ok && snap.freezeAuthority !== null) {
        holderProbe.reason = 'freeze-authority-set';
      }
    }

    const selected = new Set(planDexEnrich(pools).map((pool) => pool.contract));
    const result = scanCycle({
      now,
      source: 'live',
      wmSufficient,
      position: null,
      bench,
      pages: [pools],
      elapsedMs: discovered.elapsedMs ?? (Date.now() - startedAt),
      worldNews: null,
      trades: {},
      observation: Object.fromEntries([...selected].map((contract) => [contract, { complete: false }])),
      accounts: {},
      pagination: Object.fromEntries([...selected].map((contract) => [contract, { complete: false, reason: 'trade-or-holder-coverage-incomplete' }])),
      mints: {},
      snapshots: {},
    });
    atomicWriteJson(path.join(dir, 'bench.json'), result.bench);
    const finishedAt = new Date().toISOString();
    const report = {
      schema: 'desk-scan/v1',
      live: true,
      fixture: false,
      paper: true,
      stopped: false,
      discovery: {
        ok: discovered.ok,
        reason: discovered.reason,
        pools: pools.length,
        calls: discovered.calls,
        origin: redactUrl('https://api.geckoterminal.com'),
      },
      dexProbe: tradesProbe,
      holderProbe,
      candidates: result.candidates,
      rejected: result.rejected.slice(0, 30),
      rejectedCount: result.rejected.length,
      rejectedReasons: result.rejected.reduce((counts, row) => {
        counts[row.reason] = (counts[row.reason] || 0) + 1;
        return counts;
      }, {}),
      context: result.context,
      chief: { ...result.chief, wm_sufficient: wmSufficient },
      startedAt: new Date(startedAt).toISOString(),
      finishedAt,
      freshForMs: CYCLE_MAX_AGE_MS,
    };
    report.fresh = cycleFresh(report, Date.now());
    const usage = process.memoryUsage();
    report.process = {
      rssKb: Math.round(usage.rss / 1024),
      heapUsedKb: Math.round(usage.heapUsed / 1024),
    };
    atomicWriteJson(path.join(dir, 'scan.json'), report);
    atomicWriteJson(budgetFile, budget);
    return report;
  });
}
