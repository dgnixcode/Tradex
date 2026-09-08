# 13 - Charting and live market data

> **SCOPE NOTE, 2026-09-05 — deferred out of v1.** The owner decided Tradex is an execution product, not a reporting one: v1 displays no CoinDCX-derived prices (`ARCHITECTURE` §6a, `DECISIONS` D51). Charts, the depth panel and the trade tape are therefore out of v1, and `plan/phase-10-market-data-charting.md` is now a deferral record.
>
> **What survived and moved:** the order-book read that prices an order, and the VWAP slippage guard — both now Phase 04 tasks T04.10 and T04.11. They read the book internally and display no derived figure, so they are unaffected by clause 2.3(c) and remain the mitigation for risk R10.
>
> Everything below is retained and accurate. It is the complete design to build from if the clause is ever answered permissively — the library decision, the live-verified feed, the unit traps and the overlay spec. Estimate on revival: 8–10 developer-days.

Status: 2026-09-03 | track: product surface | scope: which charting library, where the candles come from, how live ticks merge into the current bar, and how our own fills get drawn on top.

## Verdict

- **TradingView Lightweight Charts, v5.2.1, Apache-2.0.** Verified from the npm registry and the repository LICENSE: stock Apache-2.0, 201 lines, no custom attribution or branding clause beyond §4(d)'s requirement to reproduce the NOTICE file. Purpose-built for financial series, canvas-rendered, one dependency, and it is the same lineage as the charts every trader already recognises. KLineCharts (also Apache-2.0) is the credible runner-up and is worth revisiting only if we need built-in drawing tools sooner than Lightweight Charts offers them.
- **The data feed is already solved and live-verified.** `GET https://public.coindcx.com/market_data/candlesticks?pair=&from=&to=&resolution=&pcode=` serves windowed OHLCV for **both** INR spot pairs (`I-BTC_INR`) and futures pairs (`B-BTC_USDT`), at nine resolutions - `1, 5, 15, 30, 60, 240, 480, 1D, 1M` - with no bar cap measured up to 10,080 bars (`03` F9). The documented spot `market_data/candles` endpoint, with its four fixed intervals and no windowing, is not usable for charting and should not be wired.
- **Two unit traps sit on this one endpoint, and they will produce a chart of 1970.** `from`/`to` are epoch **seconds**; the returned `time` is epoch **milliseconds**; and Lightweight Charts' `UTCTimestamp` is epoch **seconds**. So the pipeline is seconds out, milliseconds back, seconds in - two conversions, in opposite directions, on the same data path.
- **Cache candles server-side. This is not an optimisation, it is a rate-limit requirement.** `public.coindcx.com` has no published rate limit at all (`03` F1), which means we do not know what we are allowed to do - so 500 browsers must never each pull their own history. One server-side cache per (pair, resolution), warmed once and extended by the socket, serves every viewer.
- **The socket is the live edge and it is a trigger, not a truth source.** `05` verified live that the spot candle `x` flag flips exactly once per bar at the boundary, and that spot depth `vs` is a **gapless** per-market sequence. Both are usable as drop detectors, which matters because a wrong channel name is silently accepted and yields nothing forever.
- **Never price an order from a chart, and never from `/exchange/ticker`.** `01` verified the ticker endpoint is served from Cloudflare with `cf-cache-status: HIT`, so it is stale by an unknown amount. The chart is for the human; an order is priced from `market_data/orderbook` at send time (`09`).
- **The differentiator is our own data on the chart, not the chart itself.** Per-account fill markers, a group average-entry line, open limit orders, and a shaded band showing the spread between the best and worst fill in a group trade. Every competitor can draw a candle; none of them knows that twelve of a customer's accounts entered this coin at three different prices.
- **Depth is snapshot-only and cannot be trimmed.** The FAQ is explicit: orderbook socket updates are *"snapshot updates only"*, *"upto 50 recent orders"*, and limiting depth to the top 10 *"functionality is not available"*. So depth bandwidth is fixed per subscribed market - budget for it rather than hoping to reduce it.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Charting library | **TradingView Lightweight Charts 5.2.1 (Apache-2.0)** | Financial-first, canvas, tiny runtime, permissive licence with no branding condition, familiar to traders | See the F1 table |
| Candle source | `public.coindcx.com/market_data/candlesticks` | Windowed, 9 resolutions, covers INR spot and futures, live-verified | Documented spot `market_data/candles` - 4 fixed intervals, no `from`/`to`, unusable |
| Live updates | Spot/futures candle socket channel, merged into the in-progress bar | Sub-second bar updates without polling | Poll the REST candle endpoint (wasteful, and no published limit to spend against) |
| Candle caching | Server-side per (pair, resolution); browsers only ever read our cache | `public.coindcx.com` limits are unknown; browsers must not fan out to the exchange | Client-side only |
| Bar-close authority | The socket `x` flag, cross-checked against a REST refetch of the last two bars | `x` is verified to flip once per bar, but a missed socket event would leave a permanently wrong bar | Trust `x` alone |
| Depth view | Subscribe per visible market only; unsubscribe on navigation | 50 levels per snapshot, not trimmable, so cost scales with subscriptions | Subscribe to everything a customer holds |
| Timezone | Store and compute in UTC; display in IST with the offset labelled | Indian customers think in IST; bars must not silently shift | Display in UTC, or infer the browser zone |
| Price for orders | `market_data/orderbook` at send time | Ticker is CDN-cached (`01`); chart data is for humans | Chart last price, ticker last price |
| Overlays | Our fills, group average entry, open orders, group fill-spread band | The genuine differentiator | Chart-only, no platform data |
| Mobile | Same library, reduced overlays, fewer bars, no depth panel | Canvas performance and screen area | A separate mobile charting stack |

## Findings

### F1 - Library comparison

Versions, licences, package sizes and dependency counts read from the npm registry on 2026-09-04. VERIFIED.

| Library | Version | Licence | Unpacked | Files | Deps | Candles? | Verdict |
|---|---|---|---|---|---|---|---|
| **TradingView Lightweight Charts** | 5.2.1 | Apache-2.0 | 3.0 MB (all builds) | 10 | 1 | Native | **Chosen** |
| KLineCharts | 10.0.3 | Apache-2.0 | 2.8 MB | 12 | 0 | Native, plus built-in drawing tools | Strong runner-up |
| uPlot | 1.6.32 | MIT | 533 KB | 9 | 0 | Yes, minimal | Best for sparklines and equity curves, not the main chart |
| Apache ECharts | 6.1.0 | Apache-2.0 | **58.9 MB** | 1,347 | 2 | Yes, generic | Rejected: general-purpose weight for a specialised job |
| Recharts | latest | - | 7.3 MB | 839 | 11 | No real candlestick | Rejected outright |
| TradingView Advanced Charts | n/a | Free with a signed agreement; **not distributed on npm** | - | - | - | Full platform | Deferred - see below |
| Highcharts Stock | n/a | **Commercial** | - | - | - | Native | Rejected on licence cost for a bootstrapped product |

Two rows need honesty about what was not verified. **TradingView Advanced Charts** (the `charting_library` product) is obtained by application rather than from a package registry, and its terms include attribution conditions - UNVERIFIED in detail, because confirming them requires applying. It offers indicators, drawing tools and saved layouts that we would otherwise build. Recommendation: ship on Lightweight Charts, and apply for Advanced Charts in parallel so the option exists later. **Highcharts Stock** pricing was not fetched and no figure is asserted here; it is excluded on the principle that a per-developer commercial licence is the wrong trade when two Apache-2.0 options cover the requirement.

The 3.0 MB figure for Lightweight Charts is the *unpacked package*, which contains ESM, CJS, standalone and development builds. Only one ships to a browser. Measure the real bundle contribution during the build phase rather than treating 3.0 MB as the cost.

### F2 - The candle feed, precisely

VERIFIED live 2026-09-04 (`03` F9 has the full probe record).

| Parameter | Type | Notes |
|---|---|---|
| `pair` | string | `I-BTC_INR` for INR spot, `B-BTC_USDT` for futures. The **`pair`** form, not the `market`/`symbol` form used by `orders/create` |
| `from` | integer | Epoch **seconds**. Mandatory - omitting it returns `{"code":400,"message":"Invalid Request."}` |
| `to` | integer | Epoch **seconds**. Mandatory |
| `resolution` | string | Accepted: `1, 5, 15, 30, 60, 240, 480, 1D, 1M, D`. Rejected: `3, 7, 120, 720, 1W, W, 1440` |
| `pcode` | string | Documented as static `f`. Live: `s` and `f` returned **identical** data for an INR spot pair, so it does not appear to select the series |

Response: `{"s":"ok","data":[{ open, high, low, volume, close, time }, …]}`, oldest first.

| Measured property | Value |
|---|---|
| `time` unit | Epoch **milliseconds** (13 digits) - against `from`/`to` in seconds |
| Field order | `open, high, low, volume, close, time` - **`close` after `volume`**. Positional parsing silently swaps them |
| Bar cap | None found: 1 day at 1 m returned exactly 1,440 bars; 7 days at 1 m returned exactly 10,080 |
| Practical ceiling | A 30-day 1-minute pull (~43,200 bars) had not returned within a 2-minute budget. Window and cache |
| Published rate limit | **None.** Not in the rate-limit table, not in the FAQ |

### F3 - The data path

```
 browser                    our API                  cache            CoinDCX
   │  GET /candles?pair&res&from&to                    │                  │
   ├────────────────────────▶│                         │                  │
   │                         │ lookup (pair,res)       │                  │
   │                         ├────────────────────────▶│                  │
   │                         │  hit: slice and return  │                  │
   │                         │  miss//gap: fetch window                   │
   │                         ├───────────────────────────────────────────▶│
   │                         │◀── {"s":"ok","data":[…]} ───────────────────│
   │                         │ ms -> s, store, extend coverage window     │
   │◀── bars (UTCTimestamp seconds) ───────────────────│                  │
   │                                                                       │
   │  SSE/WS subscribe (pair,res)                                          │
   ├────────────────────────▶│  one upstream candle-channel subscription  │
   │                         │◀── candle event (x flag) ───────────────────│
   │◀── bar update / bar close ────────────────────────│                  │
```

Rules that make this correct rather than merely fast:

| Rule | Reason |
|---|---|
| The browser never talks to `public.coindcx.com` | Unknown rate limits; and a per-viewer fan-out is the fastest way to find them |
| One upstream subscription per (pair, resolution), fanned out to N viewers | Socket cost is per market, not per user |
| The cache records its **coverage window**, not just bars | Otherwise a request for an older range silently returns a short series |
| A bar is only final once `x` flips **and** a REST refetch of the last two bars agrees | A missed socket event would otherwise freeze a wrong bar permanently |
| Convert ms → s exactly once, at ingestion | Two conversion sites is one bug |
| Volume is a decimal, not a float | Same money-precision discipline as everything else (`05`, `09`) |

### F4 - Merging a live tick, and repairing a gap

```
on candle_event(pair, res, bar):          # bar = {open,high,low,close,volume,time_ms,x}
    t = floor(bar.time_ms / 1000)         # -> UTCTimestamp seconds
    if t  < last.t : ignore                            # stale
    if t == last.t : series.update(bar)                # same bar, replace in place
    if t  > last.t :
        if t - last.t > interval_seconds(res):          # a bar is missing
            schedule_gap_repair(pair, res, from = last.t, to = t)
        series.update(bar)                              # append
    if bar.x : mark last bar closed; enqueue verify(last two bars)
```

Lightweight Charts' `series.update()` handles both "replace the last bar" and "append a new bar" from the same call, keyed on the timestamp - so the merge is a timestamp comparison, not a mode switch. The only thing we must add is gap detection, because a dropped socket event produces a silently missing bar rather than an error.

Reconnect procedure, in order:

| Step | Action |
|---|---|
| 1 | Note the timestamp of the last bar we hold |
| 2 | Re-subscribe to the candle channel |
| 3 | REST-fetch `from = last_bar_time - 2×interval`, `to = now` |
| 4 | Merge by timestamp; the overlap of two bars is deliberate and repairs a partially-formed final bar |
| 5 | Only then resume applying socket events |

Doing step 3 *before* step 2 leaves a window in which new events are missed; doing it after re-subscribing means the overlap absorbs anything that arrived during the fetch.

### F5 - Overlaying our own data (the differentiator)

Every overlay below is data we already have from `08`, `11` and `12`. None of it requires new capture except where noted.

| Overlay | Source | Rendering |
|---|---|---|
| Per-account fill markers | `ledger_entry` where kind is `trade_buy`/`trade_sell`, joined to `child_order` | Marker at (fill time, fill price); buy below the bar, sell above; size scaled by notional |
| Group average entry | Quantity-weighted average across the group's accounts, at each fill's stored rate (`11` F8) | Horizontal line, labelled with the account count it covers |
| Group fill-spread band | Best and worst fill price within one group trade (`08` F7) | Shaded horizontal band; the width *is* the execution-quality story |
| Open limit orders | `child_order` in `open`/`partially_filled` with a limit price | Dashed horizontal line per distinct price, with a count if several accounts share it |
| Decision-time mid | Captured at planning time (`08` stage 2) | Single marker; without it, slippage is unrecoverable afterwards |
| Skipped accounts | Planning-stage refusals | Not on the chart - a footnote under it, with the reason |

The group fill-spread band is the overlay worth building first. It answers the question a customer will ask on their first group trade - *"why did account 7 get a worse price?"* - visually, without a report, and it is the one view no exchange screen can produce because no exchange knows the accounts are related.

A note on marker volume: a customer with 20 accounts trading a coin twice a day accumulates 80 markers a week on a single chart. Cluster markers that fall inside one bar into a single marker with a count, and expand on hover, or the chart becomes unreadable within days.

### F6 - Depth and the trade tape

| | Source | Constraint |
|---|---|---|
| Depth snapshot | `GET public.coindcx.com/market_data/v3/orderbook/{instrument}-futures/{depth}` for futures; `market_data/orderbook` for spot | Depth is a path segment for futures (`10`, `20`, `50`) |
| Depth live | Socket depth channel | FAQ: *"snapshot updates only"*, *"upto 50 recent orders"*, and trimming to the top 10 is *"not available"* |
| Drop detection | Spot depth `vs` is a **gapless** per-market sequence (verified live, 170 consecutive values over 170 s) | A gap or a stalled `vs` means the connection is dead-but-open |
| Trade tape | Socket new-trade channel; REST `data/trades` for the initial fill | Documented fields include `is_maker` here, unlike spot fills (`11` F1) |

Because depth arrives as full snapshots, there is no incremental-update bookkeeping and no sequence-gap repair to write - a genuine simplification. The cost is fixed bandwidth per subscribed market, which is why subscriptions must follow the *visible* market rather than the customer's holdings.

The same depth data serves two other consumers that are not charts: the slippage guard in `09` F8 and the order-price snapshot in `09`. One depth subscription, three uses.

## Design

### Invariants

| # | Invariant |
|---|---|
| V1 | Every bar timestamp handed to the chart is epoch **seconds**; every value read from CoinDCX is epoch **milliseconds** |
| V2 | The cache never returns bars outside its recorded coverage window |
| V3 | A bar is marked final only after `x` and a REST cross-check agree |
| V4 | No browser makes a request to `public.coindcx.com` |
| V5 | One upstream subscription exists per (pair, resolution), regardless of viewer count |
| V6 | A missing bar interval triggers a repair fetch, never a silent gap |
| V7 | No order price is ever taken from chart or ticker data |
| V8 | OHLCV values are parsed as decimals, never through `JSON.parse` into a `number` |

### Resolution mapping

| UI label | `resolution` | Interval seconds | Default window |
|---|---|---|---|
| 1m | `1` | 60 | 6 h |
| 5m | `5` | 300 | 1 day |
| 15m | `15` | 900 | 3 days |
| 30m | `30` | 1800 | 7 days |
| 1h | `60` | 3600 | 30 days |
| 4h | `240` | 14400 | 90 days |
| 8h | `480` | 28800 | 180 days |
| 1D | `1D` | 86400 | 2 years |
| 1M | `1M` | ~2592000 | 5 years |

Windows are chosen to keep every default request under ~1,500 bars, well inside the measured 10,080-bar comfort zone and far from the 43,200-bar request that stalled.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| ms/seconds confusion | Chart renders 1970 or year 58000 | V1; convert once at ingestion | Chart unusable - loud, at least |
| Positional parsing of the bar array | Close and volume swapped; candles look plausible but wrong | Parse by key, never by position (F2) | Silently wrong charts |
| Browsers hit `public.coindcx.com` directly | Unknown; there is no published limit to alert on | V4, server-side cache | Possible IP-level throttling that also breaks trading |
| Missed socket candle event | Gap detected by interval arithmetic (F4) | Repair fetch | One bar, briefly |
| `x` missed, last bar frozen wrong | REST cross-check disagrees | V3 | One bar, indefinitely, if unchecked |
| Wrong channel name subscribed | Silence forever, no error (`05`) | Assert data arrives within N seconds of subscribing; alarm otherwise | No live updates, looking like a quiet market |
| Dead-but-open socket | `vs` stops advancing; `x` never flips | Both used as drop detectors (F6) | Stale chart presented as live |
| Depth subscriptions grow with holdings | Bandwidth and memory climb | Subscribe to the visible market only | Client performance, then server |
| Marker overload | Chart unreadable after a week of group trades | Cluster per bar with counts (F5) | Usability |
| Customer prices a trade off the chart | - | The trade ticket prices from the book and shows that it did (`21`) | A trade at a price the customer misread |
| `pcode` semantics change | Candle response shape or content changes | Validate the response envelope; fall back to `market_data/candles` at reduced fidelity | Charts degrade; trading unaffected |

## Open questions for Anand

1. **Do we apply for TradingView Advanced Charts?** It brings indicators, drawing tools and saved layouts we would otherwise build over months, at the cost of an application, attribution terms and a non-npm distribution. Recommended default: **ship on Lightweight Charts, apply in parallel.** Nothing depends on the answer.
2. **Which resolutions appear in the UI?** All nine are available; offering all nine also multiplies cache entries by nine per pair. Recommended default: **1m, 5m, 15m, 1h, 4h, 1D at launch**, adding 30m/8h/1M on demand.
3. **Is a depth panel a v1 feature?** The data is needed anyway for the slippage guard, so the marginal cost is UI only. Recommended default: **yes, collapsed by default**, because a customer about to market-buy into an INR pair with a 0.42% spread should be able to see why.

## Phase hints

- **The charting phase has no dependency on any trading code** and can run in parallel with the execution core. Its inputs are a public endpoint and a public socket channel.
- Build the **server-side cache with its coverage window (V2)** first; a naive "fetch and return" version will be rewritten the moment a second viewer appears.
- The **ms→s conversion and key-based parsing** belong in one adapter module with a test per trap in F2. These are the two defects most likely to ship unnoticed.
- **Overlays (F5) land after fills exist**, i.e. after the first real order and the ledger. Sequence them: fill markers, then group average entry, then the fill-spread band.
- The **decision-time mid capture** is not a charting task but the chart is its main consumer - make sure `08`'s planning stage records it before the charting phase needs it, or the overlay has nothing to draw.
- The **depth subscription manager** is shared with `09`'s slippage guard. Build it once, in whichever phase comes first, and expose it to both.

## Sources

- npm registry, 2026-09-04: `lightweight-charts` 5.2.1 Apache-2.0, 10 files, 1 dependency; `klinecharts` 10.0.3 Apache-2.0, 0 dependencies; `uplot` 1.6.32 MIT; `echarts` 6.1.0 Apache-2.0, 1,347 files; `recharts` 839 files, 11 dependencies. Unpacked sizes as quoted in F1.
- https://raw.githubusercontent.com/tradingview/lightweight-charts/master/LICENSE - stock Apache-2.0, 201 lines, no additional attribution or branding clause; https://raw.githubusercontent.com/tradingview/lightweight-charts/master/NOTICE - the TradingView copyright that Apache-2.0 §4(d) requires us to reproduce.
- `03-coindcx-futures-orders-rest.md` F9 - the full live probe record for `public.coindcx.com/market_data/candlesticks`: mandatory `from`/`to`, the accepted and rejected resolution sets, `pcode=s` versus `f`, ms-versus-seconds, field order, and the 1,440 / 10,080 bar counts.
- `05-coindcx-websockets.md` - live-verified: candle `x` flips once per bar; depth `vs` is gapless over 170 consecutive values; wrong channel names are silently accepted; auth failure is a silent disconnect; money arrives as strings or exponent-form numbers.
- `_sources/coindcx-docs.txt` FAQ - orderbook socket updates are *"snapshot updates only"*, *"upto 50 recent orders"*, top-10 trimming *"not available"*; socket.io is the only supported client.
- `01-coindcx-spot-rest.md` - `/exchange/ticker` is CDN-cached (`cf-cache-status: HIT`); the documented spot `candles` endpoint's four fixed intervals.
- Cross-references: `08-fanout-execution-engine.md` (decision-time mid, execution report), `09-sizing-allocation-rounding.md` (depth for the slippage guard and order pricing), `11-positions-ledger-pnl.md` (fills for markers, group average entry), `14-analytics-product-spec.md` (equity curves - uPlot is the right tool there), `21-frontend-ux-spec.md` (chart placement and the trade ticket), `22-nonfunctional-slos-capacity.md` (socket and cache capacity).

