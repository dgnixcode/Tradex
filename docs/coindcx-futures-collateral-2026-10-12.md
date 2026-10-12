# Futures creation and collateral audit

Production diagnosis used read-only PostgreSQL queries and service logs. In the
sampled two-day window, the exchange reported 20 insufficient-funds rejections,
15 filled children and two price-tick rejections on market orders. These are
venue refusals rather than invented local statuses; a nonzero balance alone does
not establish affordability at the order's settlement rate and full entry cost.

The main confirmed software mismatch was using the spot USDT/INR midpoint to size
INR futures. CoinDCX uses a distinct fixed futures conversion. The public read
reported 102 INR/USDT while the spot book was about 98.86. A 100% allocation
therefore requested too much collateral despite the previous spot holdback.

Changes:

- Read the futures conversion endpoint, with strict currency/response validation
  and no spot fallback. Share overlapping reads and fail closed on unavailable FX.
- Persist an immutable FX snapshot linked to each plan. Migration 040 adds the
  dedicated `coindcx_futures_conversion` source; prior FX rows remain unchanged.
- Normalize instrument fee percentages to fractional notional rates. Budget for
  entry taker fees, GST on fees and 1% collateral headroom, with exact arithmetic.
  Futures sizing uses no spot TDS reserve. Explicit quantities are never resized;
  unaffordable ones are refused before confirmation.
- Re-read wallet collateral, prices and conversion before creation. A changed
  budget produces `insufficient_collateral` without sending or retrying an order.
  Historical entry prices are excluded from this new-order collateral estimate.
- Send `price: null` for market variants and omit market time-in-force. This
  conforms to the create contract; no live orders were placed to test the venue.
- Use futures conversion/fee assumptions in ticket estimates and percentage-to-
  quantity conversions, floor generated quantities to the instrument step and
  block review when conversion cannot be verified.
- Close streaming GET clients during shutdown while ordinary in-flight requests
  drain, avoiding persistent SSE connections holding a deployment open.

CoinDCX sources checked on October 12, 2026:
[API reference](https://docs.coindcx.com/#get-currency-conversion),
[create order contract](https://docs.coindcx.com/#create-order),
[fee GST disclosure](https://coindcx.com/vip/), and
[futures TDS statement](https://coindcx.com/blog/coindcx-news/what-is-1-percent-tds-on-crypto-trade-in-coindcx-pro-app).
The conversion endpoint's GET works as shown in its example, though the HTTP
request heading says POST. This adapter intentionally uses the observed read-only GET.

Migration 040 and compatible API/frontend must ship together. Back up first,
check actual queued execution and active mutation/automation states, drain the
service and preserve historical unresolved records. Do not resubmit failed or
uncertain historical orders as part of deployment. Existing leverage, margin,
protection and position records are not reconfigured by this change.

Validation uses synthetic wallets, books, positions and a fake exchange. It covers
100% INR group allocations, exact conversion provenance, long/short market/limit
quantity affordability, high-leverage fee reserves, conversion outages, and a
wallet change between preview and confirmation that sends no new exchange order.
It cannot guarantee that CoinDCX will accept or fill every future order; balances,
price, instrument rules, rate limits and venue restrictions can change.

Passed: 644 backend unit tests, 63 frontend tests, frontend production build,
type checks, lint, 8 architecture rules and 1,437 targeted PostgreSQL/fake-venue
assertions across planning, conversion provenance, collateral, balance refresh,
composition, duplicate safety and deployment checks.
