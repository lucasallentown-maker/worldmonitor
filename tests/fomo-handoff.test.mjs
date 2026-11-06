import assert from 'node:assert/strict';
import test from 'node:test';
import { fomoTokenUrl } from '../tools/desk-scan/src/fomo-link.mjs';
import { buildHandoff, renderHandoffHtml } from '../tools/desk-scan/src/handoff-view.mjs';

const MINT = 'EiEHSWpXXpYucKW9zjfyj2ixSXkvUKbHLeUkjeXDyWyF';

const summary = {
  survivingCandidates: 0,
  startedCentral: '2026-11-06 01:49:44 CST',
  endedCentral: '2026-11-06 02:09:45 CST',
  cycles: 20,
  uniquePools: 378,
  uniqueAtLastCycle: { 'liquidity-below-15k': 204, 'age-outside-10m-48h': 161 },
  holder: {
    mint: MINT,
    ticker: 'Mootun',
    drop: 'The count went from 393 at 08:01:45Z to 18 at 08:02:45Z.',
  },
};

const config = {
  bankUsd: 200,
  freeCashUsd: 200,
  lockedCapitalUsd: 0,
  fixedFraction: 0.01,
  maxFeeRate: 0.04,
  maxFeeScope: 'round-trip',
  slippageBps: 100,
};

test('a Solana token link is only the public fomo.family page', () => {
  const link = fomoTokenUrl('solana', MINT);
  assert.equal(link.ok, true);
  assert.equal(link.url, `https://fomo.family/tokens/solana/${MINT}`);
  assert.equal(link.order, false);
  assert.equal(link.wallet, false);
  assert.equal(fomoTokenUrl('solana', `${MINT}/steal`).ok, false);
  assert.equal(fomoTokenUrl('solana', 'javascript:alert(1)').ok, false);
  assert.equal(fomoTokenUrl('fomo.fund', MINT).ok, false);
  assert.equal(fomoTokenUrl('ethereum', '0x1111111111111111111111111111111111111111').url, 'https://fomo.family/tokens/ethereum/0x1111111111111111111111111111111111111111');
});

test('the empty observation is not labeled approved and the fee stays blocked', () => {
  const view = buildHandoff(summary, config);
  assert.equal(view.empty, true);
  assert.equal(view.headline, 'No candidates passed the existing filters.');
  assert.equal(view.candidates.length, 0);
  assert.equal(view.paper.preFeeNotionalUsd, 2);
  assert.equal(view.paper.suggestedNotionalUsd, 0);
  assert.equal(view.paper.feeStatus, 'blocked-no-verified-quotes');
  assert.equal(view.paper.sizeRaisedToFitFees, false);
  assert.equal(view.research[0].approved, false);
  assert.equal(view.research[0].badge, 'Not approved');
  assert.equal(view.research[0].url, `https://fomo.family/tokens/solana/${MINT}`);
  const html = renderHandoffHtml(view);
  assert.match(html, /No candidates passed the existing filters/);
  assert.match(html, /Not approved/);
  assert.match(html, /Unverified holder drop/);
  assert.match(html, /393 at 08:01:45Z to 18/);
  assert.doesNotMatch(html, /Approved candidate/);
  assert.match(html, /does not connect a wallet/);
});
