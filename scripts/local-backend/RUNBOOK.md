# Local World Monitor backend

This is the setup that was run on this machine on 2026-11-06. Commands below are the ones that were executed. Node was `v22.23.4` (`npm` 10.9.9). `.nvmrc` asks for Node 24. Node 20 or newer is enough for this path; Node 18 is not.

Docker was not installed here, so `docker compose up` was not run. The REST proxy is the same file Compose uses, `docker/redis-rest-proxy.mjs`, started on the host and bound to `127.0.0.1`.

## What the three endpoints need

The Vite dev server already serves these routes. With no Redis they answer empty, degraded, or 503. That was the earlier 0/3 result.

| Endpoint | Redis key | Producer | Upstream used in the test |
|---|---|---|---|
| `GET /api/market/v1/get-fear-greed-index` | `market:fear-greed:v1` | `scripts/seed-fear-greed.mjs` | Yahoo Finance (22/22 symbols), CNN Fear & Greed, AAII survey, TradingView S&P breadth from `scripts/seed-market-breadth.mjs` |
| `GET /api/market/v1/list-crypto-quotes` | `market:crypto:v1` | `scripts/seed-crypto-quotes.mjs` | CoinPaprika. CoinGecko is the fallback and was not needed. |
| `GET /api/intelligence/v1/list-cross-source-signals` | `intelligence:cross-source-signals:v1` | `scripts/seed-cross-source-signals.mjs` | Reads other Redis keys. This run filled earthquakes (USGS), weather alerts (NWS/ECCC/SWIC), and commodity quotes (Yahoo). The aggregator published 5 signals from weather and commodities. |

`scripts/run-seeders.sh` starts every `scripts/seed-*.mjs`. It was not used. Many of those scripts exit without a provider key, and `scripts/seed-bundle-derived-signals.mjs` is a scheduler: only its Cross-Source-Signals section writes this key. Its Cross-Strait section requires `JAPAN_MOD_PROXY_URL` or `PROXY_URL`, which were not set. Running the cross-source seeder directly is the path that was tested.

`seed-fear-greed.mjs` does not call FRED. It reads `economic:fred:v1:*` from Redis. Those keys were absent, so liquidity, credit, and macro stayed at the producer's neutral score of 50 with null inputs. The producer does not mark those three categories `degraded` (only sentiment and breadth use that flag). Sentiment and breadth were not degraded. Filling the FRED inputs needs a `FRED_API_KEY` and the FRED seeder. No key was created.

Nothing in this path calls `api.worldmonitor.app`.

## Install

From the repository root, after `npm install` for the app:

```bash
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y redis-server
node -v
npm install
npm install --prefix scripts/local-backend --omit=dev --no-audit --no-fund
```

`apt` installed Redis 7.0.15. The package's service start was denied by `policy-rc.d`, which is what we want: the next command starts its own server. Do not start the distro Redis on `0.0.0.0`.

## Start

```bash
node scripts/local-backend/up.mjs
```

That command:

1. Picks the first free port at or after 6379, 8079, and 3000. It does not kill whatever already owns a port.
2. Writes `.env.local-backend` (mode `0600`, gitignored) with a random Redis password and REST token.
3. Starts `redis-server` with `bind 127.0.0.1`, `protected-mode yes`, and `requirepass`.
4. Starts `docker/redis-rest-proxy.mjs` on `127.0.0.1` only.
5. Runs the seven seeders listed above.
6. Starts `npm run dev -- --host 127.0.0.1 --port <free> --strictPort`.
7. Probes the three endpoints up to 10 times, 3 seconds apart, and writes `.local-backend/proof.json`.

On this machine all three ports were free, so the API was `http://127.0.0.1:3000` and the REST proxy was `http://127.0.0.1:8079`. The script printed `READY 3/3` and exited 0. The processes keep running. Stop them with:

```bash
node scripts/local-backend/down.mjs
```

`down.mjs` signals only the pids in `.local-backend/pids.json`, and only when the command line is `redis-server`, `redis-rest-proxy.mjs`, or `npm run dev` / `vite`. The Vite pid is the `npm` parent; stopping its process group also stops the Vite child. After `down.mjs` on this machine, ports 3000, 6379, and 8079 were closed.

Check again any time the stack is still up:

```bash
node scripts/local-backend/readiness.mjs
```

Exit 0 and `READY 3/3` means one attempt had all three healthy. Anything else exits 1. A miss, `provider=degraded`, `unavailable: true`, a category with `degraded: true`, an empty signal list, a stale `seed-meta` record, or a non-local URL is a failure. The script does not follow redirects to another host.

## HTTP-green is not sufficient

`node scripts/local-backend/readiness.mjs` exits 0 only when all three endpoints are **sufficient** on one attempt. HTTP 200 with a real payload can still be insufficient.

Sufficient fear-and-greed needs the HTTP checks plus finite FRED inputs for M2, the Fed balance sheet, SOFR, HY and IG spreads, the funds rate, the 10y-2y curve, and unemployment. A neutral score of 50 with null inputs is blocked, not healthy.

Sufficient cross-source needs all 25 source keys fresh. A short signal list built from 3 keys is HTTP-green and blocked. Missing keys that need a credential are named. This tool does not create those credentials and does not call `api.worldmonitor.app`.

## Result of the live runs

The 2026-11-06T06:05:20Z run was HTTP-green 3/3 under the older checker. That evidence is kept in `live-proof.json` and is not a sufficiency pass.

The rerun finished attempt 10 at `2026-11-06T06:24:13Z`:

```text
NOT SUFFICIENT (HTTP-green 3/3, sufficient 1/3)
```

Crypto was the one sufficient endpoint. Fear-and-greed was blocked on all eight FRED series. Cross-source was fresh on 3 of 25 keys.

Payload sample from the preserved 06:05 HTTP-green run:

Fear and greed: HTTP 200, composite **44.7 Neutral**, `unavailable: false`, seeded `2026-11-06T06:04:52.014Z`, VIX **28.18**, CNN **20**, AAII bull **34.1** / bear **48.4**, 11 sector ETFs, S&P 500 above the 200-day average **58.32%**. No category had `degraded: true`. Source `yahoo-cboe-cnn-fred-v1`. Liquidity, credit, and macro inputs were null (see the FRED note above). Put/call was null; positioning used Yahoo `^SKEW` at 149.37.

Crypto: HTTP 200, `provider: "seed"`, 10 quotes, no unresolved ids. Source `coinpaprika-tickers+coingecko-fallback`. BTC 75522.29 (−6.29%), ETH 2220.67, SOL 89.37, and the other seven configured coins, all with a positive price.

Cross-source: HTTP 200, 5 signals, `evaluatedAt` matching seed-meta, source `cross-source-v1`. The seeder found 3 of 25 source keys. Signals:

- `^VIX` +69.7% (commodity quote list, Yahoo)
- `MTF=F` +8.3%
- 5 extreme weather alerts in Latin America
- 13 extreme weather alerts in Western Europe
- `URA` −5.3%

USGS returned 91 earthquakes. None of them produced a signal, because the extractor only emits magnitude 6.5 or greater in the last 24 hours.

## Firewall and secrets

- Redis and the REST proxy listen on `127.0.0.1` only. Do not publish 6379 or 8079, and do not set `SRH_BIND_HOST=0.0.0.0` on a machine other people can reach.
- The dev server in this run also listened on `127.0.0.1:3000` only. To put the dashboard on a network, terminate HTTPS on a reverse proxy and proxy to that local port. Leave Redis on localhost.
- `.env.local-backend` holds the REST token. It is gitignored. Do not paste it into logs, tickets, or chat. The proxy log redacts the Redis password in its connection line; still treat `.local-backend/logs/` as private.
- `scripts/local-backend/env.example` has no real secrets.

## Memory, CPU, and disk

Measured after the three RPCs had been served, from `/proc/<pid>/status` (`VmRSS`):

| Process | RSS |
|---|---|
| `redis-server` | 25 MB |
| REST proxy (Node) | 102 MB |
| `npm` / `sh` wrappers | 65 MB |
| `vite` Node process | 406 MB |
| esbuild helper | 26 MB |
| **Total** | **about 624 MB** |

A 2 second CPU sample after that was about 0% for redis, the proxy, and the npm parent. Seeding this set took about 16 seconds of wall clock (fear-and-greed 4.9 s, commodities 9.6 s, the others under 0.4 s).

`npm install` for the app used **2.3 GB** in `node_modules`. The Redis client under `scripts/local-backend` added about 5 MB. The Redis dump directory was under 1 MB.

A 1 GB machine does not fit this dev stack: Vite alone was 406 MB after it loaded the handlers, and the proxy adds another 102 MB before the operating system. Use **2 GB RAM as the minimum** and **4 GB** if seeders run while the dev server is up. Disk minimum **8 GB**, comfortable **16 GB**, because `node_modules` is already 2.3 GB. One vCPU is enough to serve; two is plenty for seeding beside it.

## Desk scan

Paper only. No orders, wallet, FOMO session, or funds.

```bash
node tools/desk-scan/run.mjs --out /tmp/desk-scan-paper
node --test tests/local-backend-readiness.test.mjs tests/desk-scan.test.mjs
```

The scan on 2026-11-06T06:22:59Z exited 3, chief `NOT_READY`. It requested two GeckoTerminal new-pool pages (both HTTP 200, 40 pools) and rejected every pool because it was younger than 10 minutes. A dex trades read parsed 62 trades and refused to treat that page as complete 24-hour coverage. `getProgramAccounts` on `https://api.mainnet-beta.solana.com` returned 53 Token-2022 accounts for the probed mint and 51 positive unique owners. Freeze authority was null. The raw top owner and top 10 were both over the 5% and 55% limits, and the count is under 100, so the mint is not a candidate. The public RPC did not deny this small account set. If a later mint is denied, `holderCount` stays null. Set `SOLANA_RPC_URL` in `.env.local-backend` to use another endpoint; the log shows only the host.

Process RSS for that scan was about 77 MB. World Monitor's dev stack was about 624 MB in the earlier measurement. Together that is still too large for a 1 GB machine. Keep the 2 GB minimum and 4 GB comfortable recommendation.

VET, SIZE, FILLS, and RISK are not implemented. The desk is not ready.

Committed evidence:

- `scripts/local-backend/live-proof.json`
- `tools/desk-scan/live-proof.json`
- `scripts/local-backend/RUNBOOK.md`
