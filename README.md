# Tradex

A multi-tenant platform where one customer connects many CoinDCX accounts by API key, organises them into named groups, and places a single trade that fans out across every account in a group - sized as an absolute amount, an absolute quantity, or a **percentage of the capital allocated to each account**. Sell side adds percent-of-holding, sell-all and close-position. Accounts may be funded in INR or USDT, and the system never silently converts between them.

**Status: research and plan complete, 2026-09-03. Scope narrowed 2026-09-05. No application code has been written yet.**

## Scope: execution, not reporting

Tradex places trades. It does **not** rebuild price charts or portfolio P&L, because those already exist in the CoinDCX app. The line is between **reading** and **displaying**:

| Read inbound - essential | Displayed outbound - our own records only |
|---|---|
| Market metadata, to size an order legally | Which account filled, at what price, and why two were skipped |
| Order book, to turn "₹20,000 worth" into a quantity | The blotter and every group-trade report |
| Balances, to fund-check and to size sell-all | Realised P&L, fees and estimated TDS from our own fills |
| Order status and trade history, to know whether it filled | |

No screen shows a CoinDCX-derived price. That is a scope decision, and it happens to remove the one contract clause that could have restricted the product (`research/ARCHITECTURE.md` §6a).

## What we guarantee, honestly

The brief asked for "100% accuracy and 100% error free". That is not achievable, and CoinDCX's own API Terms say so in capitals - clause 7 states the API is provided *"AS IS"* and that they *"DO NOT WARRANT THAT THE COINDCX API … WILL BE SAFE, UNINTERRUPTED, ERROR FREE"*. What **is** achievable, and what the whole design exists to deliver:

| | Property |
|---|---|
| **P1** | **No lost order** - every accepted intent reaches a terminal, known state |
| **P2** | **No duplicate order** - a retry can never place a second order |
| **P3** | **No silent divergence** - any mismatch with the exchange is detected, alarmed and surfaced |
| **P4** | **No wrong size** - an order is either exchange-legal before it is sent, or refused |
| **P5** | **Partial group failure is a first-class reported outcome** - never silent |

"14 filled · 3 rejected · 2 skipped · 1 needs review" is a **successful** group trade. The product is built around saying that clearly rather than hiding it.

## Where things are

| Path | Contents |
|---|---|
| `research/00-INDEX.md` | **Start here.** 22 research documents indexed, with what each answers |
| `research/ARCHITECTURE.md` | The authoritative design |
| `research/OPEN-QUESTIONS.md` | 15 questions needing you, a lawyer, or a measurement - each with a recommended default |
| `research/DECISIONS.md` | 50 decisions, sorted so the 15 one-way doors come first |
| `research/RISK-REGISTER.md` | 28 risks by severity, and the five worth losing sleep over |
| `research/DATA-MODEL.md` | The consolidated schema |
| `research/_sources/` | The 14,119-line CoinDCX docs dump that every claim traces back to |
| `plan/00-PLAN-OVERVIEW.md` | 15 phases, dependency graph, rollout ladder, go-live checklist |
| `plan/phase-NN-*.md` | One detailed build document per phase |

## The build plan

15 phases, roughly **85-105 developer-days** for one developer, or 3-4 months with two.

| # | Phase | Goal |
|---|---|---|
| 00 | Foundations | Exact money, tenancy, audit, KMS envelope, never-log enforcement - before any exchange call |
| 01 | Exchange adapter and market metadata | Signed requests work; 999 markets cached; **the rate-limit question answered** |
| 02 | Credentials and onboarding | Connect an account, validated live, with the real balance reconciled against what was typed |
| 03 | Sizing and legalisation | A pure function proven over all 999 markets |
| 04 | Groups, planning and the preview | Plan, price, slippage-guard and preview a group trade - and deliberately cannot send it |
| 05 | Kill switches, caps and degraded modes | Every brake works, proven by asserting no order is sent |
| 06 | Single-account execution and reconciliation | One real order that always reaches a terminal state |
| 07 | Fill ledger and reconciliation | An immutable record of what we did, reconciled against the exchange |
| 08 | Group fan-out | The core feature: one intent, N accounts, per-account outcomes |
| 09 | Cancel, sell-all and close | The sell side, sized from exchange truth |
| ~~10~~ | ~~Charting~~ | **Deferred** - order-book read and slippage guard moved into Phase 04 |
| ~~11~~ | ~~Private sockets~~ | **Deferred** - pure latency, nothing depends on it |
| 12 | Blotter, history and realised P&L | What happened on every trade, from our own records |
| 13 | Operations | Alerts, audit, support tooling, restore drill |
| 14 | Go-live gate | Nothing new built; everything proven |

Critical path: `00 → 01 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 13 → 14` ≈ 74-93 days.

## Before writing any code, do these four things

| Action | Effort | Why |
|---|---|---|
| **Create a second CoinDCX account and key** | 10 minutes | Needed for the rate-limit experiment - **the only gate left inside the plan**. If the limit is per **IP**, the whole platform shares 960 requests/minute, roughly 400 accounts with resting orders in total |
| **Decide whether leverage is wanted** | A conversation | Futures and margin have no idempotency key, so "no duplicate order" cannot be guaranteed on them. Default: spot only |
| **Brief a lawyer** on PMLA reporting-entity status and our liability cap | One meeting | PMLA covers *"administration of… instruments enabling control over VDAs"* - which is what storing an API key is. 53 non-compliant providers have already had apps and URLs taken down |
| **Talk to five prospective customers** running 5+ CoinDCX accounts | A few days | The only question engineering cannot answer, and the cheapest de-risking of the whole build |

Optional, no longer blocking: write to CoinDCX about API Terms clause 2.3(c). Since v1 displays no CoinDCX-derived prices, nothing waits on the answer - but a permissive reply would let charts and mark-to-market analytics return as a later phase rather than never.

## Three facts worth knowing up front

**CoinDCX offers no restricted API keys.** Their FAQ: *"all API users have the same level of permissions, API keys are interchangeable"*, and there are no read-only keys. The IP-binding option binds to the IP of the device that generated the key, so it cannot protect a server-side platform. There is no exchange-side blast-radius control available to us - our encryption is the entire defence, not defence in depth.

**"The key cannot withdraw" is not a safety property.** In the 3Commas breach, roughly 100,000 keys leaked and accounts were drained **by trading on illiquid pairs, not by withdrawing**. CoinDCX's API has no withdrawal endpoint at all, which means every Tradex customer sits in exactly the configuration that was drained.

**Percentage sizing will fail on the largest accounts, and that is arithmetic, not a bug.** `BTCINR` permits a `max_quantity` of 2 BTC but a `max_quantity_market` of only **0.0158 BTC** - about ₹1.28 lakh. So "buy 20% of allocated capital" succeeds on a ₹1 lakh and a ₹5 lakh account and is rejected on a ₹10 lakh one. The preview screen shows this, with both numbers, before anything is sent.

## Method

Every CoinDCX claim in this repository traces to a line range in `research/_sources/coindcx-docs.txt` - a 14,119-line local conversion of the full API reference. Anything not read there or measured live is tagged `UNVERIFIED`.

Live measurements taken 2026-09-04 include: 999 markets and their metadata, five tickers and their spreads, the candle endpoint's accepted and rejected resolutions, request latency (37.6 ms warm, 105 ms cold), and four npm package licences read from the registry and the `LICENSE` files. A mechanical sweep of all 64 API paths claimed across every document found **zero fabricated endpoints**.
