# Desk scan (research only)

This directory is a separable paper filter. It does not place orders, move funds, or talk to a wallet. VET, SIZE, FILLS, and RISK are not implemented, so chief stays `NOT_READY` even when World Monitor has three sufficient greens.

`node tools/desk-scan/run.mjs` calls public GeckoTerminal and the public Solana RPC. It writes `scan.json`, `bench.json`, and `gt-budget.json` under the output directory. A `position.json` object in that directory stops the scan before any network call. Fixture tests require `"fixture": true` and `"label": "FIXTURE — not live market data"`.

## Rules that are implemented

- `position.json` in the state directory stops the scan. The bench file is left untouched.
- A contract stays in `bench.json` until 25 minutes have elapsed. The first sighting only starts the bench.
- New-pool input is refused above 2 pages or past a 60 second page budget.
- The shared limiter allows 5 calls per minute. Scan may use 4. One slot stays reserved. A VET caller is rejected with `vet-not-implemented`. HTTP 429 pauses the limiter for 60 seconds.
- Cheap filters, before any enrich call: age 10 minutes through 48 hours, liquidity at least $15,000, 24h volume at least $50,000, market cap from $80,000 through $6,000,000. Market cap must be the actual `mcap` field. FDV is never a substitute.
- Dex enrich keeps at most 20 Solana pools per cycle, highest liquidity first, and only when the pool mint matches the contract.
- Trade stats use consecutive observed 5-minute windows with complete timestamp coverage. H1, H6, and H24 are sums of 12, 72, and 288 of those windows. Overlapping ranges are not subtracted from each other. Fewer than 200 trades in the H24 windows fails. An H1 window set with zero sells and 20 or more buys is rejected.
- Holders are unique owners with a positive balance. SPL and Token-2022 accounts for the same owner are added together. Zero balances are ignored. A negative amount, a missing owner, incomplete `getProgramAccounts` pagination, or a provider limit fails closed.
- Freeze authority must be JSON `null`, and the unique-owner count must be at least 100.
- Holder growth uses two or more real snapshots at least 10 minutes apart. Nothing is interpolated.
- Top owner above 5% of positive supply, or top 10 above 55%, fails. These percentages are raw. Treasuries, liquidity accounts, and every other positive owner are included. There is no exclusion list.
- Rank is holder-growth percent minus H1 price-change percent. A missing required metric cannot pass. At most 10 candidates are emitted. `degraded` on a passing row is `false`.
- `context` is world news, at most 1024 UTF-8 bytes, or `null` with `unavailable: true` when world news was not supplied. Token sentiment is not accepted as context.

## Run

```bash
node tools/desk-scan/run.mjs --out /tmp/desk-scan-paper
node --test tests/desk-scan.test.mjs
```

The live command is paper-only. On 2026-11-06 it read 40 new Solana pools (2 pages, HTTP 200), rejected all 40 for age under 10 minutes, parsed 62 public trades without treating that page as complete 24h coverage, and counted 51 positive owners on the probed mint from a real `getProgramAccounts` response. Chief exited `NOT_READY`. The measured process RSS was about 77 MB. Details are in `tools/desk-scan/live-proof.json`.

Set `SOLANA_RPC_URL` in `.env.local-backend` if the public RPC refuses `getProgramAccounts`. The scanner prints only the host. A refused call leaves `holderCount` null.
