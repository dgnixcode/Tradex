# Phase 07 — handoff note (2026-09-09)

Written at a clean, verified checkpoint so a fresh session can finish Phase 07
without re-deriving what exists. `npm run verify` was green at 39 checks,
2,366,137 assertions when this was written.

## Done and gate-proven

- **Migration 011** (`ledger_entry` partitioned + idempotency unique; `holding`; NO
  `equity_snapshot`). Applied to the live DB.
- **`packages/ledger`** (pure, exact via @tradex/money):
  - `foldLedger(rows) → Holding[]` — replay into qty / WAC / realised / fee-drag /
    tds-withheld. **07-ledger-fold (13):** hand-computed 3-trade realised P&L to
    the paisa, L6, L7, L8, L1.
  - `decomposeFill(fill) → LedgerRow[]` — the 11 F4 TDS matrix.
    **07-tds-matrix (12).**
- **`packages/db/ledger-repo.ts`:**
  - `recordFill` — the idempotent WRITER (inserts decomposed rows with
    `exchange_trade_id` set, ON CONFLICT … DO NOTHING) + `account_market_seen`
    append on NEW fills only. NOTE: the earlier draft omitted `exchange_trade_id`,
    which made the unique backstop NULL (Postgres UNIQUE ignores NULLs) — the fix
    is to always set it.
  - `reconcileBalances` — Loop D: fold books vs `account_balance`, unexplained
    diff → `approximate`. **07-loop-d (13):** re-ingest adds zero rows, a manual
    deposit is flagged, aligned books are clean.
- **No-mark-to-market boundary** — **07-no-mark-to-market (3).**

## Remaining

1. **Periodic invariant job (T07.8)** — recompute the fold and compare against the
   stored `holding` projection; alarm on L2/L6 failure. (The `holding` table is
   still never written by the app — persisting the fold is part of this.)
2. Phase 08 = group fan-out.

## Do not

- Add `equity_snapshot`, unrealised P&L, or any current-market-price valuation
  (§6a) — `07-no-mark-to-market` enforces it structurally.

