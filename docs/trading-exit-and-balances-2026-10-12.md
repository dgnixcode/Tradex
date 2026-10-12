# Exit preconditions and account refresh

## Confirmed production findings

A read-only database inspection showed an INR SOL market entry locally marked
`open`. A signed CoinDCX order-list read matched its exact stored venue ID and
returned `filled`. Position existence alone was not used as fill evidence.
No production order, cancel, exit, margin or protection action was invoked.

The Accounts Refresh button only reloaded the persisted account list. It did
not call the exchange balance sync. A separate fallback in the list projection
could replace confirmed zero balances with an old positive allocated basis.

## Changes

- Position actions scope entry checks to the account, contract and funding
  currency. Entries in another funding currency do not block this position.
- If a local entry still appears unresolved, read the exact venue ID under the
  existing position-action lock. Require matching ID, pair, margin currency and
  terminal status before proceeding. Open, partial, missing, mismatched and
  unreadable orders still block the action. Absence never proves non-placement.
- This precondition read does not enter the execution worker, rewrite historical
  entries, replay orders or attach protection. It examines at most five pages
  within a bounded read budget. Ordinary exit still cancels and verifies attached
  conditionals before closing, then verifies the position is flat.
- Accounts Refresh reads the complete connected list and refreshes exchange
  balances in batches of eight. A failed account does not prevent later batches
  from refreshing. The UI waits for cache reload and identifies failed accounts.
- Persist wallet balances and allocated basis atomically, including zero.
  The account-list fallback applies only when no balance snapshot exists.
  Both INR and USDT summary cards use their respective observed free balances.

## Validation

All execution checks use isolated local PostgreSQL schemas and FakeVenue:

- 17-trading-safety: 48 assertions, including exact terminal status evidence,
  unavailable reads, mismatched IDs/currencies, and no historical-entry writes.
- 19-composition-trading: 45 assertions against the actual server composition,
  including a blocked live entry, a stale filled entry and an empty wallet sync.
- 21-trade-balance-refresh: 51 assertions.
- 15-hard-exit-service: 21 assertions.
- 644 unit tests and 65 frontend tests pass; typecheck, lint, CI rules and
  production frontend build pass.

Deployment uses no data migration and does not invoke trading endpoints.
