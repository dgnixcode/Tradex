# Phase 14 - Go-live gate

Status: not started | goal: nothing new is built. Everything is proven, the legal answers are recorded, and the first external customer trades | depends on: all | implements: `18` F6 rung 7, `15`, `20`, `00-PLAN-OVERVIEW` checklist

## Scope

**In:** rollout rung 7; customer terms and privacy notice; the two onboarding disclosures verified live; marketing-copy review; recording the answers to G1, G2 and G3; re-measuring latency from production; executing the full go-live checklist.

**Explicitly out:** any new feature. If something is missing, it belongs in a numbered phase, not here.

## Preconditions

| Precondition | How to check |
|---|---|
| Phases 00-09 and 13 done | Every definition of done ticked |
| Rungs 0-6 passed | Evidence recorded in phases 04, 06 and 08 |
| G2 answered | Recorded in `_PROGRESS.md`; bucket configuration set from it |
| G1 answered | In writing from CoinDCX, or phases 10 and 12 shipped in their reduced form |
| G3 answered | Counsel's written conclusion on PMLA reporting-entity status |

## Tasks

**T14.1 - Rung 7**
The first external customer, on their own caps, after rung 6 has run clean for **7 consecutive days**. Runbooks written; kill switch drilled; on-call arrangement live.
*Acceptance:* 7 clean days evidenced; the customer's first group trade completes with a correct report.

**T14.2 - Customer terms**
Our liability cap; **explicit disclosure of CoinDCX's Rs 1,00,000 aggregate liability cap** and the indemnity flowing the other way; the five achievable properties (P1-P5) as our stated guarantees; no absolute claims anywhere.
*Acceptance:* counsel has reviewed; a copy review confirms "error free" and "bank-grade security" appear nowhere.

**T14.3 - Privacy notice**
DPDP consent and notice; purpose limitation; the **5-year retention** floor and the erasure-versus-retention rule stated plainly (credentials crypto-shredded immediately, transaction and identity records retained); breach process.
*Acceptance:* the erasure-versus-retention tension is explained in the notice, not discovered when the first deletion request arrives.

**T14.4 - Onboarding disclosures verified live**
Both notices render on every add-account view: CoinDCX offers no restricted keys and any key can trade and move funds between the customer's own wallets; and do **not** tick "Bind IP Address" when creating the key.
*Acceptance:* a live walkthrough confirms both; the never-ask policy is stated and there is exactly one route accepting a key.

**T14.5 - Record the three gate answers**
Write G1, G2 and G3's answers, with dates and sources, into `../research/_PROGRESS.md` and the affected documents. If G1 was refused, record what was removed from phases 10 and 12.
*Acceptance:* all three recorded; no document still describes an assumption that has since been answered.

**T14.6 - Re-measure latency from production**
The `22` F1 numbers came from an Indian residential connection. Re-measure warm and cold TTFB from the Mumbai host and sign off the SLO (p50 400 ms, p95 1 s, p99 2 s to last order sent).
*Acceptance:* production numbers recorded; the SLO is either confirmed or restated with the new evidence.

**T14.7 - Demand validation recorded**
At least five conversations with prospective customers running 5+ CoinDCX accounts, per Q11 - the only item in the plan engineering cannot answer.
*Acceptance:* notes recorded. If demand is absent, this is the moment to stop, and stopping here has cost far less than stopping later.

**T14.8 - Execute the go-live checklist**
All 22 items from `00-PLAN-OVERVIEW.md`, each objectively true or false, each with evidence.
*Acceptance:* every box ticked with a link to its evidence. A partially-ticked checklist is not a go-live.

## Schema delta

None.

## Verification

No new check script. Instead: **every existing check script runs green in one command**, with the total assertion count recorded.

Expected total across all phases: roughly **203,000 assertions**, dominated by the 999-market sizing suite (~200,000). The non-sizing total is roughly **3,000**, which is the more meaningful number for judging coverage.

## Definition of done

- [ ] Rung 6 clean for 7 consecutive days
- [ ] Rung 7 passed: first external customer's group trade completed and correctly reported
- [ ] All 22 go-live checklist items ticked with evidence
- [ ] Every check script green in one command; total assertion count recorded
- [ ] Customer terms and privacy notice live, counsel-reviewed
- [ ] Both onboarding disclosures verified in a live walkthrough
- [ ] No copy anywhere claims error-freeness or absolute security
- [ ] G1, G2 and G3 answers recorded, with affected documents updated
- [ ] Latency re-measured from production; SLO signed off
- [ ] Restore drill executed within the last 90 days
- [ ] On-call arrangement live, or trading hours restricted
- [ ] Demand validated with five prospective customers

## Phase risks

| Risk | Addressed by |
|---|---|
| R26 liability asymmetry | T14.2 - disclosed and priced, not discovered |
| R27 "error free" claimed | T14.2's copy review |
| R08 PMLA registration | T14.5's recorded G3 answer |
| R28 no demand | T14.7 - and the honest option of stopping |
| Checklist theatre | T14.8's evidence requirement per line |

## Notes for after go-live

The first candidates for a Phase 15 and beyond, in the order the research suggests: the conversion feature (`10` F5), group conversion, Loop B hardening, futures **only if** Q3 says leverage is wanted, per-membership weights (`19`), a second exchange behind the existing adapter, and a formatted tax report. None of them is required for the brief as written.
