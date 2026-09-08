# OPEN-QUESTIONS

Status: 2026-09-03 | the questions only Anand, a lawyer, or a measurement can answer. Deduplicated from all 22 research documents and filtered hard: anything a competent engineer should simply decide has been decided and moved to `DECISIONS.md`.

**Every question has a recommended default so that nothing is ever blocked waiting for an answer.** Ordered by the earliest phase they block.

---

## Q1 - May we display CoinDCX Market Data and derived analytics to our customers?

**DOWNGRADED 2026-09-05 - no longer blocking.** The owner decided that v1 is an execution product, not a reporting product: it displays **no** CoinDCX-derived prices at all. Charts, depth, mark-to-market P&L and analytics dashboards are out of v1 scope (`ARCHITECTURE` §6a), so nothing in the plan waits on this answer.

| | |
|---|---|
| **Blocks** | **Nothing.** Previously gated phases 10 and 12 |
| **Why it needs you** | It is a contract-interpretation question with a commercial answer |
| **Recommended default** | **Still send the letter** - it is one page, and a permissive answer would let charts and mark-to-market analytics return as a later phase rather than never. Bundle it with Q14 (HFT access) |
| **Cost of changing later** | Now low. If the answer is permissive we gain features; if it is restrictive we lose nothing, because we already built none of them |

The clause forbids redistributing, **displaying** or disseminating Market Data *"or any data, charts, analytics, research, or other works based on, referring to, or derived from the Market Data to any third party."* Note that `display` is the operative verb - "we are not reselling a data feed" does not reach it. What makes the question moot for v1 is that we now display nothing derived from CoinDCX prices.

**What we still read, and why it is not affected:** `markets_details`, `orderbook`, `users/balances`, `orders/status` and `trade_history` all flow *inbound* to legalise, price, fund and verify an order. That is authorised use under clause 2.1. The restriction is on outbound display. Full boundary in `ARCHITECTURE` §6a; analysis in `15` F2.

---

## Q2 - Is the CoinDCX rate limit per API key or per IP?

| | |
|---|---|
| **Blocks** | Capacity planning, reconciler cadence, pricing, onboarding pace. Effectively everything after Phase 01 |
| **Why it needs you** | It needs a second CoinDCX account with its own key - only you can create that |
| **Recommended default** | **Create the second account and run the experiment in Phase 01.** Two keys, one egress IP, read-only `users/balances` calls, two hours. Assume per-IP until measured |
| **Cost of changing later** | Low to fix the code (cadences are configuration), very high to discover in production |

If per key, capacity scales with customers and this is a non-issue. If per IP, the entire platform shares 960 requests/minute: roughly **2,400 idle accounts or 400 with resting orders, total across all customers** - and a single 20-account fan-out at a 1-second reconciler cadence would consume more than the whole per-minute budget on its own.

Design: `08` F1. Arithmetic: `22` F3. Risk `R07`.

---

## Q3 - Do we want leverage at all?

| | |
|---|---|
| **Blocks** | Whether `02` (margin) and `03` (futures) are ever implemented |
| **Why it needs you** | The brief never mentions leverage. Only you know whether it was implied |
| **Recommended default** | **No leverage in v1. Spot only.** Revisit futures once the spot fan-out has run clean for a month |
| **Cost of changing later** | Moderate - futures becomes its own phase with its own safety protocol, not a toggle |

Three findings pull in different directions and you should see all three. Against: futures and margin have **no client-supplied idempotency key**, so "no duplicate order" cannot be guaranteed - the L1-L4 lock-and-search protocol in `03` is strictly weaker than spot's. Also against: margin needs ~20% extra margin at 10x purely to fund TDS. **For:** futures attract **no TDS at all**, against 1% on an INR sell and 1% on both legs of a C2C trade - which for an active trader is a material saving. And futures is the only product where INR collateral and a real closable position coexist.

Sources: `02`, `03`, `11` F4.

---

## Q4 - What does "close the position" mean - spot holdings or leveraged positions?

| | |
|---|---|
| **Blocks** | The sell-side design in Phase 02, and Q3 |
| **Why it needs you** | The brief says several accounts in a group can hold a position in the same coin, which is equally true of plain spot holdings |
| **Recommended default** | **Treat it as spot holdings**: close = sell the full held quantity, floored to `step`. Confirm before any futures work is scheduled |
| **Cost of changing later** | Low if it means spot; high if we build spot-only and it turns out to mean futures positions |

If it means spot, the product gets substantially simpler and Q3 answers itself.

---

## Q5 - Are we a PMLA reporting entity, and must we register with FIU-IND before launch?

| | |
|---|---|
| **Blocks** | Launch. Not the build |
| **Why it needs you** | A lawyer's conclusion, in writing |
| **Recommended default** | **Assume yes and build for it.** KYC-capable customer model, 5-year retention, audit sufficient to reconstruct transactions, a named principal officer - all Phase 00 schema decisions that cost days, not weeks |
| **Cost of changing later** | Very high. 53 non-compliant providers have already had apps and URLs directed for takedown |

Notification S.O. 1072(E) covers *"safekeeping or administration of VDAs **or instruments enabling control over VDAs**"* carried out for another person in the course of business. An API key is such an instrument, and we administer it. **Non-custodial is not an exemption** - custody is only one of five triggers.

Source: `15` F5. Risk `R08`.

---

## Q6 - Confirm the percentage basis: allocated capital, as specified?

| | |
|---|---|
| **Blocks** | The sizing phase (Phase 02) |
| **Why it needs you** | It is a product-behaviour choice with a visible downside |
| **Recommended default** | **Keep it as you specified** - percent of the figure set at account-add - plus an explicit "update allocated capital" action and a nag when it diverges from the real balance by more than 25%. Offer current-equity as a per-trade option |
| **Cost of changing later** | Low mechanically; but every historical trade's basis is recorded, so past reports stay explainable either way |

The property worth knowing: the basis does not move with P&L. An account that doubled still trades 20% of its original figure; an account that halved will start **failing the balance gate**. That is not a bug, it is the definition - but it will generate support questions unless the UI shows allocated capital and real balance side by side, which `21` F5 does.

Source: `09` F4.

---

## Q7 - When an account exceeds `max_quantity_market`, what should happen?

| | |
|---|---|
| **Blocks** | The sizing phase and the preview UI |
| **Why it needs you** | Three defensible product behaviours with different risk profiles |
| **Recommended default** | **Refuse, and offer a limit order as a one-click alternative.** Do not auto-split and do not auto-convert |
| **Cost of changing later** | Low |

Measured: `BTCINR` allows `max_quantity` of 2 BTC but `max_quantity_market` of only **0.0158 BTC** (~Rs 1.28 lakh). So a ₹10 lakh account at 20% computes 0.02461 BTC and is rejected - **a group trade fails on the largest accounts first**, which is deeply counter-intuitive. Auto-splitting would turn one authorised order into several at prices the customer never saw.

Source: `09` F6, F7 row 3. Risk `R12`.

---

## Q8 - Market orders on INR pairs: allow, warn, or block?

| | |
|---|---|
| **Blocks** | The trade ticket (Phase 05) |
| **Why it needs you** | It is a risk-appetite question about your customers' money |
| **Recommended default** | **Allow with a mandatory warning** showing the measured spread and estimated round-trip cost, and refuse above a configurable 0.5% tolerance |
| **Cost of changing later** | Low |

Measured spreads: `DOGEINR` **0.81%**, `BTCINR` **0.42%**, `XRPINR` 0.36%, against `BTCUSDT` **0.0000%**. With fees and TDS, an INR round trip costs roughly 2.4%. A 20-account group trade pays that 20 times.

Source: `09` F6, `10` F7. Risk `R10`.

---

## Q9 - What are the default notional caps, and who can raise them?

| | |
|---|---|
| **Blocks** | The first real-money phase - the caps are the backstop against a fat-fingered percentage |
| **Why it needs you** | Your customers' risk tolerance |
| **Recommended default** | **Per-order Rs 2,00,000; per-day Rs 5,00,000 per tenant.** Customer-raisable with re-authentication and a confirmation step; a platform maximum above that |
| **Cost of changing later** | Cheap - configuration |

---

## Q10 - Who is on call, and do we restrict trading hours until someone is?

| | |
|---|---|
| **Blocks** | Go-live |
| **Why it needs you** | It is a staffing commitment, not a technical decision |
| **Recommended default** | **The ten money-at-risk alerts page** (`20` F2: A1, A2, A3, A5, A6, A8, A10, A11, A15, A18); everything else waits for morning. If nobody can be on call, restrict trading to supported hours until someone can |
| **Cost of changing later** | Cheap |

---

## Q11 - Has demand been validated?

| | |
|---|---|
| **Blocks** | The decision to build past Phase 02 |
| **Why it needs you** | Engineering cannot answer it |
| **Recommended default** | **Talk to five prospective customers who each run 5+ CoinDCX accounts, before Phase 02.** If they exist, everything else here is worth building |
| **Cost of changing later** | The entire build |

No India-specific or CoinDCX-specific multi-account tool surfaced in the competitive research. That is either the opportunity or the warning, and it is the cheapest possible de-risking of the whole programme.

Source: `16` F3. Risk `R28`.

---

## Q12 - What liability cap goes in our customer terms, and do we buy professional indemnity cover?

| | |
|---|---|
| **Blocks** | The first paying customer |
| **Why it needs you** | Commercial and insurance decision |
| **Recommended default** | **Mirror the upstream reality and disclose it.** CoinDCX's aggregate liability to us is capped at **Rs 1,00,000** while we indemnify them - including, on its face, for our own customers' claims. Cap our own liability, disclose the upstream cap plainly, and get a quote for professional indemnity |
| **Cost of changing later** | High - retroactive terms changes are not really a thing |

Source: `15` F1 clauses 9 and 10. Risk `R26`.

---

## Q13 - Do we tell customers plainly that CoinDCX has no restricted API keys?

| | |
|---|---|
| **Blocks** | Onboarding copy (Phase 02) |
| **Why it needs you** | It is a conversion-versus-trust trade-off |
| **Recommended default** | **Say it plainly, every time an account is added.** It is true, it is checkable, and a customer who discovers it later will assume we hid it. It also sets up the honest framing that their real kill switch is deleting the key on CoinDCX - which does not depend on us being reachable or honest |
| **Cost of changing later** | Cheap, but reputationally asymmetric |

The facts: no read-only keys, *"all API users have the same level of permissions, API keys are interchangeable"*, and IP binding attaches to the key-generating device's IP so it is unusable for us. There is no withdrawal endpoint in the API - but `16` F1 shows that accounts were drained at 3Commas **by trading, not withdrawing**, so this is not the reassurance it looks like.

Source: `07` F1, `16` F1.

---

## Q14 - Do we pursue CoinDCX's enterprise HFT programme?

| | |
|---|---|
| **Blocks** | Nothing. Pure upside |
| **Why it needs you** | It requires contacting them commercially |
| **Recommended default** | **Open the conversation early**, in the same letter as Q1. It is the only route to a sanctioned static trusted IP *and* to higher rate limits, which are the two constraints in `22` |
| **Cost of changing later** | None |

If Q2 turns out to be per-IP, ask about multiple egress IPs **in the same conversation** - and ask before implementing an IP pool, because distributing requests to raise an effective limit could be read as circumvention.

Source: `07` F1, `22` F3.

---

## Q15 - Is the audit log visible to the customer?

| | |
|---|---|
| **Blocks** | Nothing; a small feature |
| **Why it needs you** | It exposes staff activity to customers |
| **Recommended default** | **Yes.** It is cheap, it is a genuine trust feature, and it makes staff access self-policing - an insider-risk claim becomes answerable from data the customer already holds |
| **Cost of changing later** | Cheap |

---

## Answered by research - recorded so they are not re-asked

| Question | Answer | Source |
|---|---|---|
| Can we require withdrawal-disabled, IP-allowlisted keys? | **No.** CoinDCX has no key scopes, and IP binding attaches to the key-generating device | `07` F1 |
| Is there a sandbox to test against? | **No.** Zero matches for sandbox, testnet, demo or paper trading across the full 14,119-line reference | `18` F1 |
| Can we batch orders across accounts? | **No.** `create_multiple` is one key, max 10, INR markets only | `01` |
| Is "100% error free" achievable? | **No**, and CoinDCX's clause 7 says so in capitals. Five achievable properties replace it | `ARCHITECTURE` §1 |
| Which charting library? | TradingView Lightweight Charts 5.2.1, Apache-2.0, verified from the LICENSE file | `13` F1 |
| Is the 30% / 1% TDS regime still current? | **Yes.** Sections 115BBH and 194S survive into the Income-tax Act 2025; Budget 2026 made no change | `15` F4 |
| Do futures attract TDS? | **No** - which is a real argument for futures, feeding Q3 | `11` F4 |
| Can an INR-funded account trade any coin? | **No.** 310 of 649 assets are USDT-only; an INR account reaches 52% | `10` F1 |

---

## Summary: what to do this week

| Action | Effort | Unblocks |
|---|---|---|
| Write to CoinDCX: clause 2.3(c), HFT access, and (if relevant) egress IPs | One letter | Q14, and *optional* future charts (Q1 - no longer blocking) |
| Create a second CoinDCX account and key | 10 minutes | Q2's experiment - **the only gate left inside the plan** |
| Answer Q3 and Q4 | A conversation | Whether `02`/`03` are ever built |
| Brief a lawyer on Q5 and Q12 | One meeting | Launch |
| Talk to five prospective customers | A few days | Whether to build past Phase 02 |

Four of those five cost almost nothing. Since the §6a scope decision, **only Q2 gates any phase** - and it is a two-hour experiment.
