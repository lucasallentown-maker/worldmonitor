import assert from 'node:assert/strict';
import test from 'node:test';
import { cheapFilter } from '../tools/desk-scan/src/rules.mjs';
import { cadenceGap, emptyWatch, upsertWatch, watchPools } from '../tools/desk-scan/src/watch.mjs';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');

function pool(createdAt) {
  return {
    ticker: 'LIVE',
    contract: 'Mint111111111111111111111111111111111111111',
    chain: 'solana',
    createdAt,
    liquidityUsd: 20_000,
    volumeH24Usd: 60_000,
    mcap: 200_000,
    poolAddress: 'Pool111111111111111111111111111111111111111',
  };
}

test('a young pool stays on the watch and is rechecked with the same age rule', () => {
  const first = upsertWatch(emptyWatch(), [pool(NOW - 2 * 60_000)], NOW);
  assert.equal(first.added, 1);
  assert.equal(cheapFilter(watchPools(first.watch)[0], NOW).reason, 'age-outside-10m-48h');
  const later = upsertWatch(first.watch, [pool(NOW - 2 * 60_000)], NOW + 11 * 60_000);
  assert.equal(later.added, 0);
  assert.equal(later.unique, 1);
  assert.equal(later.watch.pools['Mint111111111111111111111111111111111111111'].firstSeenAt, NOW);
  assert.equal(cheapFilter(watchPools(later.watch)[0], NOW + 11 * 60_000).ok, true);
});

test('cadence gap uses start times and ignores the planned wait', () => {
  assert.equal(cadenceGap(null, 1_000).gap, false);
  assert.equal(cadenceGap(0, 60_036, 60_000).gap, false);
  assert.equal(cadenceGap(0, 70_000, 60_000).gap, true);
  assert.equal(cadenceGap(0, 70_000, 60_000).gapMs, 10_000);
});
