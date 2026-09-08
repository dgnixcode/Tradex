# Phase 10 - DEFERRED: market data display and charting

Status: **deferred out of v1, 2026-09-05** | reason: the read/display decision (`ARCHITECTURE` §6a) - v1 displays no CoinDCX-derived prices | depends on: nothing in v1

## Why this phase no longer exists in v1

Tradex is an execution product. Price discovery and P&L already exist in the CoinDCX app, so v1 does not rebuild them. Everything this phase was going to display - candlestick charts, the depth panel, the trade tape, the numeric spread warning, mark-to-market values - is a work derived from CoinDCX Market Data rendered onto a screen, which is exactly and only what clause 2.3(c) restricts.

Dropping it retires risk **R04** by scope rather than by mitigation, and removes the plan's only external gate.

## What moved rather than disappeared

The order-book **read** is still essential and is not a display concern. It moved into Phase 04's planning stage:

| Capability | Where it now lives | Why it must stay |
|---|---|---|
| Order-book read for the price used to size an order | **Phase 04, T04.10** | There is no notional parameter in the CoinDCX API, so "₹20,000 worth" must become a quantity from a real price |
| VWAP walk and the slippage guard | **Phase 04, T04.11** | The mitigation for R10 - a market order into a thin INR pair (`DOGEINR` measured at 0.81% spread) loses real money with no bug present |
| Qualitative spread warning | **Phase 04, T04.11** | The ticket says "spread is wide on this market - a limit order is recommended" **without displaying the derived number** |

So the guard survives, ungated, because it reads the book internally and shows no CoinDCX-derived figure.

## What was dropped

| Dropped | Replacement for the customer |
|---|---|
| Candlestick chart, 9 resolutions, server-side candle cache | The CoinDCX app, or a third-party widget if one is ever embedded |
| Depth panel and trade tape | The CoinDCX app |
| Numeric spread and round-trip cost estimate | A qualitative warning plus a refusal above tolerance |
| Fill markers, group average-entry line, fill-spread band on a chart | The execution report's divergence figures, which are our own data (`plan/phase-12`) |

The overlays are the genuine loss here. They were the most distinctive thing in the product, and they are the first thing to revive if the letter comes back permissive.

## If clause 2.3(c) is answered permissively

This phase returns essentially as written before the rescope. `research/13-charting-live-market-data.md` remains complete and accurate: the library decision (Lightweight Charts 5.2.1, Apache-2.0, licence verified), the live-verified candle feed with its nine resolutions and the seconds-versus-milliseconds trap, the coverage-window cache design, and the overlay specification. Re-reading that document is the whole of the planning work; estimate remains **8-10 developer-days**.

One thing to preserve in the meantime: the **decision-time mid** is still captured at plan time in Phase 04 (`14` F2). It costs nothing to store and it is unrecoverable afterwards - so if charting returns later, the historical overlay data will exist.

## Sources

- `ARCHITECTURE.md` §6a - the read/display boundary
- `DECISIONS.md` D51 - the scope decision and its reversibility
- `RISK-REGISTER.md` R04 - retired by scope
- `research/13-charting-live-market-data.md` - the full design, retained for when this phase revives
- `research/15-india-regulatory-compliance.md` F2 - the clause analysis
