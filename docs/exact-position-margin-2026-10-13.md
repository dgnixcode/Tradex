# Exact individual position margin

The previous amount input derived a target leverage, rounded it, then called
`update_leverage`. This did not guarantee that typing ₹500 would transfer ₹500.

CoinDCX documents separate futures `positions/add_margin` and
`positions/remove_margin` endpoints with `timestamp`, `id` and a native amount.
INR positions receive INR amounts; USDT positions receive USDT amounts.
The documentation also describes position inactivity, liquidation, insufficient
funds and maximum-removal refusals. Sources: [API reference](https://docs.coindcx.com/#add-margin-1)
and [leverage versus added margin](https://coindcx.com/blog/announcements/leverage-based-position-limits-tiered-maintenance-margin-on-coindcx-explained).

The individual modal now dispatches an exact amount transfer when the amount
input or amount chip was last edited. Explicit target leverage and slider actions
retain the leverage endpoint. Entering an amount never silently clamps it to a
different value. The action button names the currency and exact amount. Effective
leverage and liquidation values are labelled estimates; configured leverage and
position quantity are unchanged by the native transfer.

The modal reads the authenticated account's native futures wallet on the leverage
tab. The server independently re-reads the live position and futures wallet before
an add; there is no spot-wallet fallback, FX conversion, or notional sizing.
Only active isolated positions are eligible. Removing all collateral is refused
locally; CoinDCX remains authoritative for the smaller safe removal limit.
Permissions, kill switches, account health, entry-order safety and durable
position-action receipts apply to margin transfers as well. Requests are never
automatically retried. An unknown transfer outcome retains the exclusion lock for
review; a later display-refresh failure cannot convert acknowledged success into
a failed transfer.

Amounts are decimal strings until signed. The exchange payload contains a JSON
number serialized from the exact decimal, with no floating-point amount rounding.
INR input precision is two places and USDT is eight places; venue validation may
be stricter for a particular position.

Tests exercise the actual server composition with FakeVenue and isolated local
PostgreSQL: ₹500 changes ₹10,000 collateral to ₹10,500, leaves exactly ₹500 from
a ₹1,000 wallet, preserves quantity/leverage, and debits only once on request-key
replay. Checks cover currency/precision errors, fresh shortfalls and conflicting
retry keys. Unit tests cover signed amount bytes, HTTP-200 refusals and ambiguous
responses. UI tests cover exact ₹500 submission, double clicks and the existing
decimal leverage/group controls. No live margin transfer or order is used to test
this feature. No migration is required.
