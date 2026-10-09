# ROE trailing stops

New trade tickets and individual/group management explicitly request `stepBasis: 'roe'`. The default step is **one percentage point** of favourable unrealised return on the account's current position margin. It is not 1% of the coin price, 1% of existing profit or a fixed currency amount. Groups calculate each account independently.

The selected initial stop gap is preserved. For example, a position with entry 100, quantity 1, margin 10 USDT and stop 95 needs a favourable price move of 0.10 for a 1 percentage point ROE step. Its stop moves to 95.10. Another account with margin 20 USDT needs a 0.20 move. The step does not mean the stop locks in the current profit or guarantees realised returns.

The initial gap on a new ticket remains explicitly labelled **price %**. Management uses the exact SL the user selected. The review screen displays the persisted initial SL and trailing step basis. A stop starts tracking from enablement, including when the position already has a profit or loss. Reversals never loosen it. Venue tick rounding can require several ROE steps before a stop can advance.

For linear contracts, the favourable price span for a step is:

`current position margin × (stepBp / 10000) / (absolute quantity × settlement conversion)`

INR margin on USDT contracts requires the position's actual settlement rate. Native INR quotes and USDT collateral use conversion 1. Leverage is already reflected by the actual margin and is not multiplied again. Arithmetic in the worker uses scaled integers through 18 decimal places. Displayed live and group ROE also use actual collateral; group ROE is weighted by margin. These are unrealised, mark-based returns, not an estimate of final proceeds after execution, fees and funding.

## Safety and compatibility

- Margin, size, direction, average entry or settlement-rate changes reset the step baseline without moving the existing stop. Changing the denominator is not treated as profit. Account positions refresh independently of the price loop every 15 seconds, and every actual replacement re-reads venue data under the account/pair action lock.
- Missing or stale margin/FX information and stale fallback prices cannot advance a stop. Before cancelling protection, the worker verifies its configuration claim, the current venue stop, the current position basis and the stop's direction relative to the fresh mark. An external stop change requires review/re-enablement.
- Manual SL changes clear the previous trailing baseline under that same lock. Enabling/disabling trailing also uses the lock. Concurrent workers claim a step once and only consume its baseline after a confirmed exchange update.
- If entry protection succeeds but collateral is unavailable, the fixed SL retains its confirmed venue ID. Trailing is marked failed and the SL leg carries `TRAILING_INACTIVE` with a reason. It must not be presented as rejected or automatically attached again.
- Fixed SL/TP, pending market/limit entry protection, quantity defaults and existing order lifecycle remain supported. A resting limit is still an order, not a filled position; its trailing registration occurs after protection is attached to the observed fill.
- Historical live trails and queued intent default to `price` in migration 039. Their percentages are not silently reinterpreted. Re-enable trailing through the new management UI to switch an existing position to ROE steps. The old plan writer omitted trailing fields; those historical missing settings cannot be reconstructed automatically.

## Release

Apply `039_trailing_roe_steps.sql` after the other migrations included in the shared checkout. It adds an explicit basis and baseline and changes stored stop/extreme prices from whole numbers to decimals. Back up and rehearse on staging first. Drain/pause trading requests and stop all old trailing/API workers before activating the new UI or creating ROE configurations: an older worker does not understand the new basis. Deploy compatible database, API and workers together, then release the frontend. Do not roll an older worker onto ROE rows; retain migration/state and keep trading paused until a compatible release is restored.

Existing exchange-native stops remain separate from the service. Trailing requires a healthy running service and current exchange data. Stop replacement still has the venue's cancel/create interval; this change does not remove slippage, partial outcomes or uncertain exchange responses. See `security-trading-audit-2026-10-08.md` for the combined release and uncertain-action recovery procedure. No production deployment or real-money test was performed for this change.

## Validation

Root TypeScript, production frontend build, 621 backend unit tests, 43 frontend tests, repository architecture rules and targeted backend lint passed. The ROE database/HTTP check covers per-account thresholds, rebasing, stale data, fractional storage, concurrent claims, action locks and legacy defaults. The production composition check uses a local signature-verifying fake exchange and covers saved/reloaded ROE intent, confirmed protection, resting limit cancellation, fresh retry intent and unavailable collateral. Desktop and 390×844 mobile controls were inspected with invented account data; no trading mutation was submitted in the browser.
