import { readFileSync } from 'node:fs';
import { fomoTokenUrl } from './fomo-link.mjs';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function buildHandoff(summary, config) {
  const bank = Number(config?.bankUsd);
  const fraction = Number(config?.fixedFraction);
  const preFee = Number.isFinite(bank) && Number.isFinite(fraction) ? bank * fraction : null;
  const quotesKnown = false;
  const research = [];
  if (summary?.holder?.mint) {
    const link = fomoTokenUrl('solana', summary.holder.mint);
    research.push({
      ticker: summary.holder.ticker || null,
      chain: 'solana',
      contract: summary.holder.mint,
      approved: false,
      passedFilters: false,
      action: 'Open in FOMO',
      badge: 'Not approved',
      reason: 'Observed during the read-only scan. It did not pass the existing filters.',
      url: link.ok ? link.url : null,
      linkReason: link.ok ? null : link.reason,
    });
  }
  return {
    schema: 'fomo-handoff/v1',
    empty: (summary?.survivingCandidates ?? 0) === 0,
    headline: 'No candidates passed the existing filters.',
    observation: {
      startedCentral: summary?.startedCentral || null,
      endedCentral: summary?.endedCentral || null,
      cycles: summary?.cycles ?? null,
      uniquePools: summary?.uniquePools ?? null,
      survivingCandidates: summary?.survivingCandidates ?? 0,
      uniqueAtLastCycle: summary?.uniqueAtLastCycle || {},
      holderDropUnverified: summary?.holder?.drop || null,
      holderCountsTrustworthy: false,
    },
    paper: {
      bankUsd: config?.bankUsd ?? null,
      freeCashUsd: config?.freeCashUsd ?? null,
      lockedCapitalUsd: config?.lockedCapitalUsd ?? null,
      fixedFraction: config?.fixedFraction ?? null,
      preFeeNotionalUsd: preFee,
      suggestedNotionalUsd: quotesKnown ? preFee : 0,
      feeStatus: 'blocked-no-verified-quotes',
      maxFeeRate: config?.maxFeeRate ?? null,
      maxFeeScope: config?.maxFeeScope ?? null,
      slippageBps: config?.slippageBps ?? null,
      slippageScope: 'per-side',
      sizeRaisedToFitFees: false,
      liveOrder: false,
    },
    candidates: [],
    research,
  };
}

function row(item) {
  const url = item.url
    ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.action)}</a>`
    : 'Link unavailable';
  return `<article>
    <p><strong>${escapeHtml(item.ticker || 'Token')}</strong> <span class="badge">${escapeHtml(item.badge)}</span></p>
    <p>Chain ${escapeHtml(item.chain)}</p>
    <p>Contract <code id="contract">${escapeHtml(item.contract)}</code></p>
    <p>${escapeHtml(item.reason)}</p>
    <p>${url}</p>
    <p>This opens a public page. It does not connect a wallet or submit an order.</p>
  </article>`;
}

export function renderHandoffHtml(view) {
  const reasons = Object.entries(view.observation.uniqueAtLastCycle || {})
    .map(([reason, count]) => `<li>${escapeHtml(reason)}: ${escapeHtml(count)}</li>`)
    .join('');
  const warning = view.observation.holderDropUnverified
    ? `<p class="warn">Unverified holder drop. ${escapeHtml(view.observation.holderDropUnverified)} Do not treat that holder series as trustworthy.</p>`
    : '';
  const scanner = view.scanner
    ? `<p>Scanner status: ${escapeHtml(view.scanner.phase)}. Last cycle: ${escapeHtml(view.scanner.lastCycleAt || 'none yet')}. ${view.scanner.stale ? 'Stale.' : 'Not stale.'} ${view.scanner.error ? `Error: ${escapeHtml(view.scanner.error)}` : 'No error.'} ${view.scanner.skipped ? `Skipped: ${escapeHtml(view.scanner.skipped)}.` : ''}</p>
  <p>This is a public market scan. It is not a fee quote and it is not a trade. Suggested paper entry ${escapeHtml(view.paper.suggestedNotionalUsd)}.</p>`
    : '';
  const refresh = view.scanner ? '<meta http-equiv="refresh" content="15">' : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${refresh}
  <title>Paper handoff — not an order</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; max-width: 46rem; line-height: 1.45; }
    .warn { background: #fff4d6; padding: 0.75rem 1rem; }
    .badge { border: 1px solid #444; padding: 0.1rem 0.4rem; }
    code { word-break: break-all; }
  </style>
</head>
<body>
  <h1>Paper handoff</h1>
  ${scanner}
  <p>${escapeHtml(view.headline)}</p>
  <p>Observation ${escapeHtml(view.observation.startedCentral)} to ${escapeHtml(view.observation.endedCentral)}. Cycles ${escapeHtml(view.observation.cycles)}. Unique pools ${escapeHtml(view.observation.uniquePools)}. Surviving candidates ${escapeHtml(view.observation.survivingCandidates)}.</p>
  ${warning}
  <h2>Why pools were rejected</h2>
  <ul>${reasons}</ul>
  <h2>Paper suggestion</h2>
  <p>Bank ${escapeHtml(view.paper.bankUsd)} dollars. Free cash ${escapeHtml(view.paper.freeCashUsd)}. Locked ${escapeHtml(view.paper.lockedCapitalUsd)}. Fixed fraction ${escapeHtml(view.paper.fixedFraction)} gives ${escapeHtml(view.paper.preFeeNotionalUsd)} dollars before the fee gate. Suggested entry ${escapeHtml(view.paper.suggestedNotionalUsd)} dollars. Fee status ${escapeHtml(view.paper.feeStatus)}. Slippage ${escapeHtml(view.paper.slippageBps)} basis points per side. Combined fee cap ${escapeHtml(view.paper.maxFeeRate)} of the entry notional, ${escapeHtml(view.paper.maxFeeScope)}. Size was not raised to fit a fee.</p>
  <h2>Research links</h2>
  ${view.research.map(row).join('') || '<p>No observed mint to link.</p>'}
  <h2>Passed the filters</h2>
  <p>None. A blocked mint is not labeled approved.</p>
</body>
</html>
`;
}

export function writeHandoff(summaryPath, configPath) {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const view = buildHandoff(summary, config);
  return { view, html: renderHandoffHtml(view) };
}
