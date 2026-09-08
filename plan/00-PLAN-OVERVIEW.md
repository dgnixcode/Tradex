# Tradex build plan - overview

Status: 2026-09-03 | 15 phases, 00 to 14. Derived from the 22 research documents and the five synthesis documents in `../research/`. Every phase ends in something demonstrable, with its own runnable check script.

## Sequencing principles

These were not chosen for tidiness; each prevents a specific failure found in the research.

| # | Principle | The failure it prevents |
|---|---|---|
| 1 | Security and exact-money foundations precede the first API call | A credential or a float bug retrofitted through every path later |
| 2 | Nothing touches real money until the kill switch, the caps and shadow mode exist | An unbounded loss with no way to stop it |
| 3 | A single account is proven end to end before group fan-out is built | Fan-out multiplies whatever is still wrong, by twenty |
| 4 | Reconciliation ships **with** the first real order, never after | An unreconciled order is a customer's money in an unknown state |
| 5 | Analytics and charts come after the ledger is trustworthy | Building projections on unreconciled data guarantees rework |
| 6 | Every phase has a check script and an assertion count | "Done" becomes a command anyone can run |
| 7 | Pure functions before the I/O that uses them | Sizing and the ledger fold are exhaustively testable only while pure |

## Phases

Sizes assume **one developer, full-time**, and include tests and the check script. They are estimates for sequencing, not commitments.

| # | Phase | Goal | Depends on | Size |
|---|---|---|---|---|
| 00 | Foundations | Repo, exact money, tenancy, audit, KMS envelope, never-log enforcement - all before any exchange contact | - | 8-10 d |
| 01 | Exchange adapter and market metadata | Signed requests work; 999 markets cached and versioned; **the rate-limit experiment is answered** | 00 | 6-8 d |
| 02 | Credentials and onboarding | A customer can connect an account, validated live, with the real balance reconciled against what they typed | 00, 01 | 6-8 d |
| 03 | Sizing and legalisation | A pure function turns any intent into an exchange-legal quantity or a named refusal, proven over all 999 markets | 00, 01 | 6-8 d |
| 04 | Groups, planning and the preview | Groups exist; a group trade can be planned, priced from the order book, slippage-guarded and previewed per account - **and not sent** (rung 0) | 02, 03 | 10-12 d |
| 05 | Kill switches, caps and degraded modes | Every switch and cap works, tested by asserting that no order is sent | 04 | 4-5 d |
| 06 | Single-account execution and reconciliation | One real order, on real money, that always reaches a terminal state (rungs 1-3) | 05 | 10-12 d |
| 07 | Fill ledger and reconciliation | An immutable record of what we did, reconciled against the exchange. **Rescoped**: no mark-to-market | 06 | 6-7 d |
| 08 | Group fan-out | The product's core feature: one intent, N accounts, per-account outcomes (rungs 4-6) | 07 | 8-10 d |
| 09 | Cancel, sell-all and close | The sell side, sized from exchange truth, plus the open-order sweep | 08 | 6-8 d |
| ~~10~~ | ~~Market data and charting~~ | **DEFERRED** (§6a). The order-book read and slippage guard moved into Phase 04 | - | 0 d |
| ~~11~~ | ~~Private sockets~~ | **DEFERRED**. Pure latency; nothing depends on it | - | 0 d |
| 12 | Blotter, execution history and realised P&L | What happened on every trade, from our own records. **Rescoped**: 14 of 22 metrics, no dashboards or curves | 07, 08 | 4-5 d |
| 13 | Operations | Alerts, customer-visible audit, support tooling without decrypt, restore drill | 08 | 6-8 d |
| 14 | Go-live gate | Rung 7, terms, disclosures, incident comms, legal answers recorded | all | 4-5 d |

**Total: roughly 85-105 developer-days** (down from 100-125 before the read/display decision), or 4-5 months for one developer, 3-4 months for two.

Worth being precise about where the saving lands: phases 10, 11 and 12 were mostly **off** the critical path, so the shortest possible schedule barely moves. What the rescope actually removes is total effort, the second developer's workload, and the plan's only external gate.

## Dependency graph

```
 00 Foundations
  ├──▶ 01 Adapter + metadata ──┬──▶ 03 Sizing ──┐
  │        │                   │                │
  │        └──▶ 02 Credentials ┴────────────────┴──▶ 04 Planning + preview
  │                                                  (order-book pricing +
  │                                                   slippage guard live here)
  │                                                      │
  │                                                      ▼
  │                                              05 Kill switches + caps
  │                                                      │
  │                                                      ▼
  │                                        06 Single-account execution
  │                                           + resolve + Loops A & C
  │                                                      │
  │                                                      ▼
  │                                        07 Fill ledger + Loop D
  │                                                      │
  │                                        ┌─────────────┴─────────────┐
  │                                        ▼                           ▼
  │                                  08 Fan-out                (rungs 1-3 done)
  │                                        │
  │                          ┌─────────────┼─────────────┐
  │                          ▼             ▼             ▼
  │                  09 Close/cancel   12 Blotter    (rungs 4-6)
  │                          │          + realised P&L
  │                          ▼
  │                  13 Operations ──▶ 14 Go-live gate
  └──────────────────────────────────────────▲
                              (Q5 legal answer required here)

 DEFERRED, not on any path:  10 Charting (§6a)   ·   11 Private sockets
```

**Critical path:** `00 → 01 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 13 → 14`. Roughly **74-93 days**. Phases 02 and 12 are off it.

## What a second developer can do in parallel

| While the critical path is on | Second developer builds |
|---|---|
| 01 Adapter | 02 Credentials and onboarding (needs only 00 plus the adapter's public calls) |
| 03 Sizing | The fake exchange (`18` F2) and the frontend shell, design system and `<Money>` component |
| 04 Planning | The trade-ticket UI against a stubbed preview API |
| 06 Execution | 07's pure ledger fold over fixtures |
| 08 Fan-out | 12's metric module (pure functions over fixtures) |
| 09 Close | 13 Operations: alerts, dashboards, support tooling |

With two developers the realistic range is **3-4 months** to the go-live gate. Note there is less parallel work than before the rescope - charting and sockets were the two largest independent workstreams, and both are deferred.

## Gates

Two gates remain, and only one is inside the plan.

| Gate | Question | Blocks | Recommended action |
|---|---|---|---|
| **G2** | Is the rate limit per key or per IP? (`OPEN-QUESTIONS` Q2) | Reconciler cadence, capacity, pricing | **Phase 01 task.** Two keys, one IP, read-only calls, two hours |
| **G3** | Are we a PMLA reporting entity? (Q5) | Phase 14 / launch | Counsel. Build KYC-capable regardless |
| ~~G1~~ | ~~Does clause 2.3(c) permit displaying Market Data?~~ | **Retired.** v1 displays no CoinDCX-derived prices (`ARCHITECTURE` §6a) | Still worth asking - a permissive answer revives phases 10 and 12's dropped surface as additive work |

G2 is a task in Phase 01. G3 is outside the plan and must be started early, because counsel answers on their own schedule.

## Rollout ladder mapped to phases

From `18` F6. The ladder is the real-money spine of the plan.

| Rung | What | Cap | Phase |
|---|---|---|---|
| 0 | Dry run - full pipeline, send suppressed | Rs 0 | 04 |
| 1 | One account, one order | Rs 100 | 06 |
| 2 | One account, ten orders incl. a cancel and a partial fill | Rs 100 | 06 |
| 3 | One account, larger | Rs 1,000 | 06 |
| 4 | Two accounts, one group | Rs 1,000 / Rs 2,000 | 08 |
| 5 | Five accounts, **deliberate partial failure** | Rs 1,000 / Rs 5,000 | 08 |
| 6 | Twenty accounts | Customer caps | 08 |
| 7 | First external customer | Their caps | 14 |

Rung 5 is the one most likely to be skipped and the one that matters most: partial failure is the *normal* outcome of a group trade, so skipping it means shipping the normal case untested.

## Go-live checklist

Every line is objectively true or false.

| # | Item | Source |
|---|---|---|
| 1 | All 73 numbered invariants have a passing test carrying the same id | `18` F3 |
| 2 | Every check script passes, with its assertion count recorded | `18` F8 |
| 3 | Secret canary test passes: a sentinel credential appears in zero logs, zero error payloads, zero responses | `07` F6 |
| 4 | The `web` process demonstrably cannot decrypt a credential (IAM assertion test) | `17` F3 |
| 5 | Signer runs as a separate process with sole KMS decrypt permission | `07` F5 |
| 6 | Restore drill executed: restore → real CMK → decrypt → sign a live read-only request → HTTP 200 | `07` F8, `20` F4 |
| 7 | Worker-kill simulation passes: no duplicate order after a kill mid-fan-out | `18` F5 |
| 8 | Rollout rungs 0-7 all passed, with evidence recorded | `18` F6 |
| 9 | Kill switches drilled at all four scopes | `05` phase |
| 10 | Alerts A1, A2, A3, A5, A6, A8, A10, A11, A15, A18 firing and routed | `20` F2 |
| 11 | On-call arrangement agreed and documented, or trading hours restricted | Q10 |
| 12 | Incident-comms templates written | `20`, `16` L5 |
| 13 | All seven runbooks written and reviewed | `20` F3 |
| 14 | Customer terms include our liability cap and disclose the Rs 1,00,000 upstream cap | Q12 |
| 15 | Privacy notice covers DPDP consent, retention and the erasure-vs-retention rule | `15` F7 |
| 16 | Both onboarding disclosures live: no restricted keys, and the IP-binding warning | Q13, `21` F5 |
| 17 | No marketing copy claims "error free" or absolute security | `R27` |
| 18 | No screen displays a value derived from a current CoinDCX price (§6a boundary holds) | `ARCHITECTURE` §6a |
| 19 | G3 answered by counsel | Q5 || 20 | 5-year retention configured and partition maintenance running | `15`, `22` |
| 21 | Latency re-measured from the production host; SLO signed off | `22` F1 |
| 22 | Demand validated with at least five prospective customers | Q11 |

## What is deliberately not in this plan

| Not built | Why | Where the decision lives |
|---|---|---|
| Futures and margin trading | No client-supplied idempotency key, so "no duplicate order" cannot be guaranteed | `ARCHITECTURE` §10, D06 |
| Leverage | Not in the brief; pending Q3 | Q3 |
| Bots, DCA, grid, rule engines | Separate products with their own correctness burden | `16` F4 |
| Copy trading or any discretionary feature | Changes the regulatory posture entirely | `15` F6 |
| Backtesting | Needs historical infrastructure; invites advisory framing | `16` F4 |
| A second exchange | The adapter boundary makes it possible later | D12 |
| Native mobile app | Responsive web; the preview table needs width | D50 |
| Per-membership weights and caps | Would add a second sizing basis | D23 |
| BTC/ETH/USDC/TRX-quoted markets | Would make BTC a funding currency - a different product | `10` |
| Any trading advice | Permanent, deliberate | D29 |
| **Price charts, depth panel, trade tape** | §6a - v1 displays no CoinDCX-derived prices | D51, `phase-10` |
| **Unrealised P&L, equity, exposure, drawdown, curves, dashboards** | §6a - all require valuing a holding at a current CoinDCX price | D51, `phase-12` |
| **Private sockets** | Pure latency; polling is sufficient and nothing depends on them | D20, `phase-11` |

## How to read a phase document

Each `phase-NN-*.md` contains: scope in and **explicitly out**; preconditions with how to check each; numbered tasks `TNN.x` with acceptance criteria; the schema delta for that phase only; interfaces; the check script it adds and its assertion target; a definition of done where every line is objectively verifiable; phase-specific risks; and notes on what is deliberately left rough for the next phase.

Start with `phase-00-foundations.md`. Before starting anything, read `../research/OPEN-QUESTIONS.md` and act on the five items in its final table - four of them cost almost nothing and two of them shape this plan.
