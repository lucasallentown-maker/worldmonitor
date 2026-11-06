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

Sufficient cross-source means every returned signal is fresh and its own source key is fresh. Coverage of the other feeds is reported. It is not a requirement that all 25 keys exist, because the endpoint's job is the signals it actually published, not a full feed inventory. A signal whose source key is missing or stale is blocked. This tool does not create credentials and does not call `api.worldmonitor.app`.

## Result of the live runs

The 2026-11-06T06:05:20Z run was HTTP-green 3/3 under the older checker. That evidence is kept in `live-proof.json` and is not a sufficiency pass.

The rerun finished attempt 10 at `2026-11-06T06:24:13Z` with HTTP-green 3/3 and sufficient 1/3, before any FRED import.

After the sanitized export was imported and the seeders ran again, attempt 10 at `2026-11-06T06:55:35Z` was:

```text
NOT SUFFICIENT (HTTP-green 3/3, sufficient 2/3)
```

Crypto and cross-source were sufficient. Fear-and-greed was HTTP 200, composite 47.2 Neutral, VIX 28.18, and still blocked on `FRED:M2SL` and `FRED:WALCL`. SOFR 3.94 (2026-11-04), HY 3.32, IG 0.91, fed funds 3.88 (2026-10-01), 10y-2y 0.38 (2026-11-05), and unemployment 4.2 (2026-09-01) were finite. M2 23413.9 is only the 2026-09-01 print, so the 52-step change stays null. WALCL 6748145 is only the 2026-11-04 print, so the 4-step change stays null. Those earlier observations were not invented. The import is not a scheduled FRED refresh.

```bash
FRED_OBSERVATION_EXPORT=scripts/local-backend/fred-observation-export.json node scripts/local-backend/up.mjs
node scripts/local-backend/down.mjs
```

A lasting deploy should set `FRED_API_KEY` on the host and run `scripts/seed-fred-rates.mjs`. Do not treat the import file as a substitute cron.

The 120-observation history export was imported the same way. Retrieval time `2026-11-06T00:58:30.990372-06:00`. Observations were stored oldest-first because fear-and-greed reads the last array element as the latest print. No dates were added.

```bash
FRED_OBSERVATION_EXPORT=scripts/local-backend/fred-history-export.json node scripts/local-backend/up.mjs
node scripts/local-backend/down.mjs
```

The first history import used a 52-row M2 step. On this monthly series that row is 2022-05-01, which is not one year. The seeder now compares the latest print with the observation dated exactly one calendar year earlier. A missing anniversary is left null. WALCL stays four observation steps, which is about four weeks when the prints are weekly, and is not a calendar month.

Re-seeded with the same history file, readiness attempt 1 at `2026-11-06T07:05:42Z` was **SUFFICIENT 3/3**. Fear-and-greed was HTTP 200, composite **48.5 Neutral**, VIX 28.18, seeded `2026-11-06T07:05:15.096Z`, no degraded category. M2 calendar year is **2026-09-01** **23413.9** versus **2025-09-01** **22149.2** (`m2Yoy` **5.709912773373308**, window `calendar-year`). WALCL four-step is **2026-11-04** **6748145** versus **2026-10-07** **6747560** (`fedBsMom` **0.008669800639045818**, window `4-observation-step`). SOFR 3.94. Crypto and cross-source stayed sufficient. This is imported data. It does not prove a cloud key fetch or a scheduled refresh.

## Acceptance audit, 2026-11-06

Read-only observation is safe to run with the commands below. The paper pipeline runs and fail-closes, and it is not ready to size a position. Live trading is disabled.

After the code above, the same history import reached SUFFICIENT 3/3 again. Fear-and-greed stayed **48.5 Neutral**, M2 **2026-09-01 23413.9** versus **2025-09-01 22149.2** (`m2Yoy` 5.709912773373308). `node scripts/local-backend/fred-refresh.mjs` then printed `mode=sanitized-history`, `keyRefresh=untested-no-secret`, `freshness=within-import-ttl`. No API key was fetched. The stack was stopped and ports 3000, 6379, and 8079 were closed. The systemd unit files were not enabled.

| Check | Status | Evidence |
|---|---|---|
| Install and start | PASS | `npm install`, Redis install, and `FRED_OBSERVATION_EXPORT=scripts/local-backend/fred-history-export.json node scripts/local-backend/up.mjs` reached SUFFICIENT 3/3 |
| Three endpoint sufficiency | PASS | Attempt 1 at `2026-11-06T07:05:42Z`. Not a claim that the desk is ready |
| M2 calendar year and WALCL 4-step | PASS | Dates and values above. Tests cover missing months, order, short history, and future dates |
| Read-only public scan | PASS | `node tools/desk-scan/run.mjs --out /tmp/desk-scan-audit` read 40 GeckoTerminal pools, 0 candidates, holder count 323 with mint and freeze both verified null. Chief `NOT_READY`. No order |
| Paper CLI path | PASS as a labeled fixture | `node tools/desk-scan/run.mjs --paper-fixture tools/desk-scan/fixtures/paper-cycle.json --out /tmp/paper-accept` printed `PAPER FIXTURE PASS`. Idempotent open, close deleted once, second close did not delete, `humanWatch` false, `liveOrder` false |
| Timers, bench lock, 429 budget, holder history, authority | PASS | `node --test` on the window, readiness, desk-scan, paper, and Fear and Greed doc tests. Clocks are injected. The 429 pause and bench lock tests passed |
| Kill during close | PASS | `tests/desk-crash-close.test.mjs` SIGKILLs at lock, partial temp, temp, and rename for the journal and the positions file. The position stays until the confirmed close is in `journal.json`. A second close does not delete again |
| Paper costs and timers | PASS as arithmetic | `feeBps` and `slippageBps` are basis points of notional (1 bp = 0.0001). A quote with 50 bp is `price * 1.005`. Missing rates stay null. Kelly stays unset and size stays 0. The three clocks arm on 5 min, 30 s, and 60 s separately |
| Paper bank | BLOCKED | `tools/desk-scan/paper.config.example.json` leaves `bankUsd` null. A copied 200 dollar balance is rejected unless `bankUsdSource` is `user-entered`. No default was applied |
| Social | PASS_PARTIAL | No handle is `PASS_PARTIAL` with `verifiedReads: null`. A handle with no connector is `BLOCKED`. A claimed verified read is rejected. Missing authority or holder RPC still rejects the dossier |
| Scheduled FRED refresh | PASS for the localhost worker, UNTESTED for a live key | `scripts/local-backend/fred-refresh.mjs` imports sanitized history and refuses a non-local Redis URL. A stale export fails closed. The systemd timer is every 6 hours and was not enabled. Key fetch was not run |
| Live orders, wallet, FOMO, funds | BLOCKED | Not implemented |
| Whole desk | BLOCKED | Not ready |

Minimum choices before a sized paper entry, with no defaults. Units are in `tools/desk-scan/paper.config.example.json`.

- `bankUsd` in dollars. Leave it null. A prior 200 dollar desk balance is not a default. Set `bankUsdSource` to `user-entered` only when you type the paper bank yourself.
- `freeCashUsd`, `lockedCapitalUsd`, `realizedProfitUsd`, and `liquidityUsd` in dollars. Use 0 only when that is the real balance. Locked capital is not spent.
- `feeBps` and `slippageBps` in basis points of notional. One basis point is 0.0001. There is no venue fee schedule.
- `maxFeeRate` as a fraction of notional. The floor `max(0.0045 * dollars, 0.95) / dollars` must not exceed it.
- `retest` set to true only if you want that requirement.
- Kelly `probability` (0 to 1) and `payoff` (ratio) only after paper history exists. Leave them null. Size stays 0.
- `socialHandle` null until you have one. No handle is `PASS_PARTIAL`. The public connector is blocked and does not read X.

Read-only commands:

```bash
FRED_OBSERVATION_EXPORT=scripts/local-backend/fred-history-export.json node scripts/local-backend/up.mjs
node scripts/local-backend/readiness.mjs
node tools/desk-scan/run.mjs --out /tmp/desk-scan-audit
node tools/desk-scan/run.mjs --paper-fixture tools/desk-scan/fixtures/paper-cycle.json --out /tmp/paper-accept
node tools/desk-scan/run.mjs --paper-config tools/desk-scan/paper.config.example.json --out /tmp/paper-config
node --test tests/fred-calendar-windows.test.mjs tests/fred-refresh.test.mjs tests/fear-greed-doc-parity.test.mjs tests/local-backend-readiness.test.mjs tests/desk-scan.test.mjs tests/desk-paper.test.mjs tests/desk-executable.test.mjs tests/desk-crash-close.test.mjs
# Host timer files only. Do not enable them from this tree:
# scripts/local-backend/systemd/worldmonitor-fred-refresh.service
# scripts/local-backend/systemd/worldmonitor-fred-refresh.timer
node scripts/local-backend/down.mjs
```

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
node --test tests/local-backend-readiness.test.mjs tests/desk-scan.test.mjs tests/desk-paper.test.mjs
```

The scan on 2026-11-06T06:22:59Z exited 3, chief `NOT_READY`. It requested two GeckoTerminal new-pool pages (both HTTP 200, 40 pools) and rejected every pool because it was younger than 10 minutes. A dex trades read parsed 62 trades and refused to treat that page as complete 24-hour coverage. `getProgramAccounts` on `https://api.mainnet-beta.solana.com` returned 53 Token-2022 accounts for the probed mint and 51 positive unique owners. Freeze authority was null. The raw top owner and top 10 were both over the 5% and 55% limits, and the count is under 100, so the mint is not a candidate. The public RPC did not deny this small account set. If a later mint is denied, `holderCount` stays null. Set `SOLANA_RPC_URL` in `.env.local-backend` to use another endpoint; the log shows only the host.

Process RSS for that scan was about 77 MB. World Monitor's dev stack was about 624 MB in the earlier measurement. Together that is still too large for a 1 GB machine. Keep the 2 GB minimum and 4 GB comfortable recommendation.

## Acceptance matrix

| Piece | State | Evidence |
|---|---|---|
| Local Redis, three HTTP endpoints | Tested | `2026-11-06T06:05:20Z` HTTP-green sample in `scripts/local-backend/live-proof.json` |
| Sufficiency, not just HTTP 200 | Tested | Rerun `2026-11-06T06:24:13Z`: HTTP-green 3/3, sufficient 1/3. Crypto passed. Fear-and-greed blocked on eight FRED series. Cross-source is sufficient only when every returned signal's own source key is fresh. The other feeds are reported and are not a 25-key pass requirement. |
| GeckoTerminal discovery and dex read | Tested live, paper | `tools/desk-scan/live-proof.json`. 40 pools, all under 10 minutes old. 62 trades parsed and not treated as a full tape. |
| Solana holder read | Tested live for one small mint | 51 positive owners, freeze authority null, concentration over the raw limits. Public RPC did not deny that call. |
| 24h trade count from Dex `transactions.h24` | Tested fixture | `tests/desk-paper.test.mjs`. A long tape without the Dex field fails. |
| Holder history, two complete snapshots, 10 minutes | Tested fixture | Incomplete snapshots are refused. |
| VET | Tested fixture | Unknown authority, a set freeze authority, stale cycle, under 100 holders, and a social claim all fail. Social stays unavailable. No social endpoint is called. |
| SIZE | Tested fixture | 6% of `bank`, then capped by free cash and 2% of liquidity. Locked capital is not spent. Missing bank, fee, slippage, max fee, or retest fails. Kelly without probability and payoff sizes 0. |
| Paper ledger | Tested fixture | Open is idempotent. Close does not delete until the journal has `confirmed: true`. Recovery rebuilds from the journal. No P&L field is filled. |
| RISK | Tested fixture | Malformed volume is not zero. Clocks fire at 5 minutes and 30 seconds. Fee floor above the configured max fails. Entry and exit interfaces do not submit. |
| CHIEF | Tested fixture | Two failures in an hour stop new entries. `humanWatch` is false. |
| Live orders, wallet, FOMO, funds | Blocked | Not implemented. |
| FRED key | Blocked | Instructions below. No account or key was created. |
| Whole desk | Not ready | VET through chief are paper fixtures. They are not a live trading system. |

## FRED API key, read from St. Louis Fed docs

Checked read-only on 2026-11-06. No account was created and no key was requested.

1. Read https://fred.stlouisfed.org/docs/api/api_key.html. It says a key cannot be requested or viewed until you are logged into a `fredaccount.stlouisfed.org` user account. Version 1 sends the key as the `api_key` query parameter. The documented shape is a 32-character lowercase alphanumeric string. The example key on that page is a demonstration only.
2. Register or sign in at https://fredaccount.stlouisfed.org/login/secure. The register help page is https://fred.stlouisfed.org/help/account/fred-account-features/register/. It says the form asks for an email and a password and the account is activated on submit.
3. After login, open API Keys from the account menu. https://fredaccount.stlouisfed.org/apikeys redirects unsigned visitors to the login page, so that is the key page behind the account.
4. Version 2 is documented separately at https://fred.stlouisfed.org/docs/api/fred/v2/api_key.html and uses `Authorization: Bearer` instead of the query parameter.
5. Put the key you receive in gitignored `.env.local-backend` as `FRED_API_KEY`. Do not commit it. Fear-and-greed stays insufficient until the FRED seeder has written the eight series and readiness shows those inputs as finite numbers.

VET, SIZE, paper fills, and paper risk are fixture-tested and are not live execution. The desk is not ready.

These paper inputs have no defaults. A missing value fails closed:

- `feeBps`
- `slippageBps`
- `maxFeeRate` (the fee floor is `max(0.0045 * dollars, 0.95) / dollars` and must not exceed this)
- `retest` set to `true` only when you have decided that a retest is required
- `lockedCapital` (kept unchanged; it is not added to spendable cash)
- `bank` (the 6% ceiling is `0.06 * bank`; the order is then capped by free cash)
- Kelly `probability` and `payoff` (if either is absent, size is 0; a probability outside 0–1 or a non-positive payoff fails)
- `realizedProfit` as a real number, including 0 (it is not assumed)

Committed evidence:

- `scripts/local-backend/live-proof.json`
- `tools/desk-scan/live-proof.json`
- `scripts/local-backend/RUNBOOK.md`
