# 21 - Frontend and UX specification

Status: 2026-09-03 | track: product surface | scope: every screen, with most of the detail on the trade ticket and the per-account confirmation preview - the two surfaces where a mistake costs real money.

## Verdict

- **The confirmation preview is the most important screen in the product, not the trade ticket.** It is the last moment a human can stop a mistake from fanning out across twenty accounts. It must show, per account, the exact computed quantity, the price basis, the estimated cost, and for every account that will be **skipped**, the specific reason - all computed server-side, all before anything is sent. A ticket without this screen is a loaded gun with no safety.
- **Show the three numbers customers confuse, side by side, everywhere.** Allocated capital (what they typed), free balance (what the exchange says), and equity (what it is worth). The owner's sizing rule uses the first, the gates use the second, and the analytics show the third. Displaying only one guarantees a support ticket per account (`09` F4, `14` F4).
- **Partial group failure is a normal outcome and the UI must be designed around it, not apologise for it.** "14 filled · 3 rejected · 2 skipped · 1 needs review" is a *successful* group trade. The report must make each bucket clickable, each reason readable, and offer retry for only the failed subset - as a fresh, re-priced trade (`08` open question 3).
- **Friction must scale with notional, and the preview must expire.** Typed confirmation above a threshold, no double-submit, submit disabled until the preview is fresh, and a visible countdown that invalidates it. A market order executed ninety seconds after the customer read a price is a different trade from the one they approved.
- **Format INR the Indian way or the numbers will be misread.** `₹12,34,567` not `₹1,234,567`, with lakh and crore shorthand in headline positions. Crypto quantities render at the market's own precision - never trimmed, never padded, never in exponent notation.
- **Web first, and mobile-responsive rather than a separate app.** The trade ticket needs a wide preview table; the analytics need charts. A native app is a later decision, and nothing here forecloses it.
- **Every refusal shows the number that caused it.** "Below minimum order size" is a shrug; "Below the minimum of 1 DOGE for this market - your 20% works out to 0.4 DOGE" is an answer. Every gate in `08` F3 and every refusal in `09` F5 already carries the numbers.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Platform | Web app, responsive down to tablet; phone gets a reduced trade ticket | The preview table needs width; charts need pixels | Native-first, or a separate mobile codebase |
| Framework | React with TypeScript, Vite | Matches the owner's existing stack (`17`); no SSR requirement for an authenticated dashboard | Next.js (SSR buys nothing behind a login), Svelte (smaller ecosystem for the team) |
| Routing | File-agnostic client router (React Router) | A dashboard, not a content site | A meta-framework router |
| Server state | TanStack Query | Polling, invalidation and stale-while-revalidate are the whole app's data pattern | Redux for server data, hand-rolled fetch hooks |
| Client state | React state plus a small store for the trade ticket draft | The only genuinely stateful surface is the ticket | A global store for everything |
| Live updates | One SSE or WebSocket stream from **our** server, never from CoinDCX | Browsers must not touch the exchange (`13` V4); one connection per user, not per account | Per-account browser sockets |
| Design system | A small internal component kit: table, money, badge, sheet, ticket controls | Money and quantity rendering must be one component, used everywhere | A large UI framework, or ad-hoc styling |
| Money rendering | A single `<Money>` component that takes minor units + currency + scale | Formatting mistakes are then impossible to make locally | Format at each call site |
| Preview freshness | Server-issued preview with a hard expiry, countdown shown, submit disabled on expiry | Prices move; a stale preview is a different trade | Client-side timer only |
| Confirmation friction | Tiered: single click below Rs 25,000; explicit checkbox to Rs 2,00,000; typed amount above | Proportionate; constant friction gets clicked through | One confirmation level for everything |
| Destructive actions | Sell-all, close-position and disconnect-account always require typed confirmation | Irreversible, and the cost of a slip is total | Same friction as a buy |
| Error presentation | Grouped by cause, with counts, expandable to per-account detail | 20 identical errors are one problem, not twenty | A flat list of 20 rows |
| Number formatting | Indian grouping for INR; market precision for crypto; never exponent notation | `₹12,34,567` is what the customer reads elsewhere | Locale-default grouping |
| Accessibility | Keyboard-operable ticket, visible focus, no colour-only status, `aria-live` on execution progress | A trading screen used under time pressure needs it most | Defer |

## Findings

### F1 - Screen inventory

| Screen | Purpose | Priority |
|---|---|---|
| Sign in + 2FA | Authenticate; 2FA required to reach credentials or trading (`19`) | P0 |
| Accounts list | Every connected account: name, currencies, allocated vs real, status | P0 |
| Add / edit account | The onboarding form and its live validation (`07` F9) | P0 |
| Groups list | Groups with member counts and combined allocated capital | P0 |
| Group builder | Add/remove accounts, reorder, per-membership caps if enabled (`19`) | P0 |
| **Trade ticket** | Compose one group trade | P0 |
| **Confirmation preview** | Per-account plan, skips and reasons, before send | P0 |
| Execution progress | Live per-account status while the fan-out runs | P0 |
| Execution report | The settled outcome (`08` F7) | P0 |
| Positions | Holdings per account and per group, dust flagged | P1 |
| Blotter | Every child order, filterable | P1 |
| Group dashboard | `14` F3 | P1 |
| Account dashboard | `14` F3 | P1 |
| P&L report + CSV | `14` F3 | P2 |
| Settings | Caps, kill switch, valuation currency, notification preferences | P1 |
| Audit log | Who did what (`20`) | P2 |

### F2 - The trade ticket

```
┌─ NEW GROUP TRADE ─────────────────────────────────────────────────────────────┐
│ Group   [ INR majors            ▾ ]   12 accounts · ₹40,00,000 allocated      │
│ Coin    [ BTC                   ▾ ]   INR market ₹80,77,476  ·  spread 0.42% ⚠│
│                                                                                │
│ Side    ( ● BUY )  ( ○ SELL )                                                 │
│ Type    ( ● MARKET )  ( ○ LIMIT )                                             │
│                                                                                │
│ Size by  [ % of allocated ▾ ]     ┌──────────┐                                │
│                                   │   20  %  │   of allocated capital         │
│          amount · quantity ·      └──────────┘   ⓘ basis: figure set when     │
│          % of allocated · % held                    each account was added     │
│                                                                                │
│ ⚠ Market order on an INR pair. Measured spread 0.42%; estimated round trip     │
│   2.4% including the 1% TDS on sale. [ use a limit order instead ]             │
│                                                                                │
│                                        [ Preview 12 accounts →  ]             │
└────────────────────────────────────────────────────────────────────────────────┘
```

| Control | Behaviour |
|---|---|
| Group | Shows account count and combined allocated capital immediately - the customer must see the scale of what they are about to do |
| Coin | Typeahead over the 649 tradable assets; shows which quote markets exist, so a USDT-only coin is visible as such *before* the preview (`10` F1) |
| Side | BUY / SELL. Selecting SELL switches the sizing modes to quantity, amount, % of held, and sell-all |
| Type | MARKET / LIMIT, filtered by the market's own `order_types` - `BTCINR` offers only these two (`09` F6) |
| Size by | Four modes: amount, quantity, % of allocated, % held. The basis is named inline, not hidden in a tooltip |
| Limit price | Appears only for LIMIT, with best bid/ask helper buttons and a distance-from-touch readout |
| Spread warning | Rendered from live orderbook data whenever a market order is selected; states the measured spread and the round-trip estimate (`10` F7, `14` M21) |
| Preview button | The only way forward. There is no "submit" on this screen at all |

Deliberate omissions: no submit button, no leverage control (spot-only v1), no advanced order types the market does not support, and no free-text quantity field that bypasses the basis selector.

### F3 - The confirmation preview

Server-computed, per account, with a hard expiry. This is the screen that makes the correctness guarantees visible.

```
┌─ CONFIRM · BUY BTC · 20% of allocated · MARKET ──────── expires in 0:23 ⏱ ────┐
│ 10 accounts will trade  ·  2 will be skipped  ·  est. total ₹6,84,120         │
│ priced from order book, best ask ₹80,77,476 at 11:02:14                        │
├───────────────────────┬──────────┬─────────────┬───────────┬───────────────────┤
│ Account               │ Market   │   Quantity  │  Est cost │ Note              │
├───────────────────────┼──────────┼─────────────┼───────────┼───────────────────┤
│ Ravi main             │ BTCINR   │  0.00246 BTC│  ₹19,871  │ 20% of ₹1,00,000  │
│ Ravi second           │ BTCINR   │  0.01230 BTC│  ₹99,353  │ 20% of ₹5,00,000  │
│ Priya main            │ BTCINR   │  0.00615 BTC│  ₹49,676  │ 20% of ₹2,50,000  │
│ … 7 more                                                                       │
├───────────────────────┼──────────┼─────────────┼───────────┼───────────────────┤
│ ⚠ Anil large          │ BTCINR   │      —      │     —     │ SKIPPED · market  │
│                       │          │             │           │ order limit is    │
│                       │          │             │           │ 0.0158 BTC; 20%   │
│                       │          │             │           │ of ₹10,00,000 is  │
│                       │          │             │           │ 0.02461 BTC       │
│                       │          │             │           │ [ use limit → ]   │
│ ⚠ Test account        │ BTCINR   │      —      │     —     │ SKIPPED · order   │
│                       │          │             │           │ value ₹80.77 is   │
│                       │          │             │           │ below the ₹100    │
│                       │          │             │           │ market minimum    │
└───────────────────────┴──────────┴─────────────┴───────────┴───────────────────┘
│ ☐ I understand 2 accounts will be skipped and this cannot be undone once sent  │
│                                    [ cancel ]   [ Place 10 orders ]           │
└────────────────────────────────────────────────────────────────────────────────┘
```

Requirements this screen must meet:

| Requirement | Reason |
|---|---|
| Every row's quantity is the **exact** value that will be sent | If the displayed number differs from the sent number, the screen is worse than useless |
| Skip reasons quote the actual limits and the actual computed value | "Below minimum" is unactionable; the numbers make it actionable |
| Skipped rows are visually distinct and cannot be scrolled past unnoticed | They are the surprising part |
| A remedy link where one exists (limit order, convert currency, top up) | Turns a dead end into a next step |
| Countdown to expiry, and submit disabled at zero | The preview is a price quote; quotes expire (`08` F8) |
| Acknowledgement checkbox appears **only** when accounts will be skipped | Constant friction gets clicked through; conditional friction is read |
| Typed confirmation above the notional threshold, replacing the checkbox | Proportionate to blast radius |
| The price basis and timestamp are stated | "Priced from order book, best ask ₹80,77,476 at 11:02:14" is the audit trail the customer can see |

### F4 - Execution progress and the report

Progress, while the fan-out runs (`08` F4). Each row updates independently; `aria-live` announces terminal transitions.

```
┌─ PLACING 10 ORDERS ───────────────────────────────── 7 of 10 settled · 1.8s ──┐
│ Ravi main        ✓ filled     0.00246 @ ₹80,79,100    ₹19,875   +8bp slip     │
│ Ravi second      ✓ filled     0.01230 @ ₹80,78,200    ₹99,362   +5bp          │
│ Priya main       ◐ partial    0.00400 of 0.00615      working                 │
│ Meena main       ⟳ sending    …                                               │
│ Kiran main       ✗ rejected   insufficient balance — short ₹1,240             │
│ …                                                                             │
└───────────────────────────────────────────────────────────────────────────────┘
```

The settled report adds the group-level facts that only we can compute:

| Block | Contents |
|---|---|
| Headline | "10 filled · 1 rejected · 2 skipped · 0 need review", each a filter |
| Divergence | Best fill, worst fill, spread between them in basis points (`14` M19) |
| Totals | Requested vs placed vs filled, per currency, then converted with the rate shown |
| Timing | Submit to first order, submit to last terminal state (`14` M22) |
| Per account | Quantity, price, slippage vs decision-time mid, fee, TDS estimate, outcome, reason |
| Retry | "Retry 1 failed account" - opens a **fresh** ticket, re-priced, new preview |

The retry button deliberately does not re-run the old plan. Re-sending a plan built against a price from two minutes ago is exactly the mistake the preview expiry exists to prevent.

### F5 - Add account, and the reconciliation moment

```
┌─ CONNECT A COINDCX ACCOUNT ───────────────────────────────────────────────────┐
│ Account name      [ Ravi main                              ]                  │
│ Allocated capital [ ₹ 5,00,000        ] ⓘ percentage sizing is a share of     │
│                                          this figure, not of the live balance │
│ API key           [ ••••••••••••••••••••••••••••••••       ]                  │
│ API secret        [ ••••••••••••••••••••••••••••••••       ]  paste only      │
│                                                                                │
│ ⓘ CoinDCX does not offer restricted API keys — any key can trade and move     │
│   funds between your own CoinDCX wallets. It cannot withdraw to an external    │
│   address. You can delete the key on CoinDCX at any time.                      │
│ ⚠ Do not tick "Bind IP Address" when creating the key — it binds to your own   │
│   device's IP and our servers will not be able to connect.                     │
│                                                     [ Verify and connect → ]  │
└────────────────────────────────────────────────────────────────────────────────┘

after a successful verify:
┌─ CHECK THESE NUMBERS ─────────────────────────────────────────────────────────┐
│ You entered allocated capital   ₹5,00,000                                     │
│ CoinDCX reports free balance    ₹3,84,120 INR  ·  0.00 USDT                   │
│                                                                                │
│ Percentage sizing will use ₹5,00,000. At 20% that is ₹1,00,000 — more than     │
│ the balance available, so trades may be skipped.                               │
│   ( ● use ₹3,84,120 instead )   ( ○ keep ₹5,00,000 )                          │
│                                                     [ Connect account ]       │
└────────────────────────────────────────────────────────────────────────────────┘
```

The second panel is the whole of `07` F9 step 2 made visible, and it is where the product earns trust: it refuses to let a customer walk away believing a number that will cause skips later. The two disclosure notes are not legal boilerplate - both are verified facts (`07` F1) that the customer cannot discover from CoinDCX's own UI, and the IP-binding warning pre-empts the single most likely onboarding failure, which otherwise presents as an indistinguishable auth error.

### F6 - Number formatting

| Kind | Rule | Example |
|---|---|---|
| INR, precise | Indian digit grouping, 2 decimals only when non-zero | `₹12,34,567` · `₹19,870.61` |
| INR, headline | Lakh / crore shorthand above 1 lakh, with the precise value on hover | `₹42.19 L` · `₹1.84 Cr` |
| USDT | Western grouping, 2 decimals for display, full scale on hover | `4,024.19 USDT` |
| Crypto quantity | Exactly the market's `target_currency_precision`; trailing zeros kept | `0.00246 BTC` · `112 DOGE` |
| Never | Exponent notation, anywhere, for anything | not `2.46e-3` |
| Percent | 2 decimals for returns, basis points for slippage and divergence | `+4.62%` · `+8bp` |
| Rate | Always shown when a converted figure is displayed | `@ 99.11` |
| Estimated values | Suffixed and styled distinctly | `₹8,240 (est.)` |

`DOGEINR` at `target_currency_precision = 0` renders as `112 DOGE`, with no decimal point at all - the formatter must take precision from market metadata rather than guessing from the value (`09` F6).

## Design

### Invariants

| # | Invariant |
|---|---|
| U1 | No screen can submit a trade without a fresh, server-issued preview |
| U2 | The quantity displayed on the preview equals the quantity sent, exactly |
| U3 | Every skipped account is visible on the preview with a reason containing numbers |
| U4 | Submit is disabled while a request is in flight and after preview expiry |
| U5 | All money rendering passes through one `<Money>` component |
| U6 | No status is conveyed by colour alone |
| U7 | Every irreversible action (sell-all, close, disconnect) requires typed confirmation |
| U8 | Estimated values are visually distinguishable from measured ones |
| U9 | The trade ticket is fully keyboard-operable, including the sizing mode switch |
| U10 | No browser request ever goes to a CoinDCX host |

U2 deserves a test rather than a review: render the preview, submit it, and assert the outbound request bodies match the displayed table row for row.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Customer submits a stale preview | Server rejects an expired preview token | U1, U4, visible countdown | A trade at an unseen price |
| Double-submit places two group trades | Duplicate `group_trade_id` attempts | U4 plus server-side idempotency on the preview token | Twenty duplicate orders |
| Skipped accounts unnoticed | Customer reports "only 10 of 12 traded" | U3, conditional acknowledgement checkbox | Trust, and a support ticket per group trade |
| Displayed quantity differs from sent | U2 test | Single source: the server's preview rows are the execution plan | Total loss of confidence, deservedly |
| INR formatted Western-style | Visual review, snapshot tests | U5, one formatter | Misread amounts - a 10x error is one glance away |
| Exponent notation leaks into the UI | Snapshot test on small quantities | Decimal strings end to end (`05`, `09`) | Unreadable, possibly misread |
| Colour-only success/failure | Accessibility audit | U6: icon plus text | Excludes users; misread under glare |
| Customer ticks "Bind IP Address" when creating the key | Auth failure at verify | The explicit warning in F5, and the three-cause error message (`07` F9) | One account, blocked, with a confusing cause |
| Retry re-runs a stale plan | - | Retry opens a fresh ticket (F4) | A trade at a price nobody approved |
| Progress screen closed mid-fan-out | - | Execution continues server-side; the report is durable and reachable from the blotter | None, if the customer is told this |

## Open questions for Anand

1. **Confirmation thresholds.** Recommended default: **single click below Rs 25,000, checkbox to Rs 2,00,000, typed amount above** - and the typed-amount tier always applies to sell-all and close-position regardless of size. These are cheap to change and worth setting deliberately.
2. **Does the customer see the CoinDCX key-permission disclosure at every account add, or once?** Recommended default: **every time**, compactly. It is the one fact that materially changes their risk and it costs two lines.
3. **Mobile scope for v1.** Recommended default: **responsive read-only on phone** - dashboards, positions, blotter, report - with the trade ticket available on tablet and up. A twenty-account preview table cannot be read on a phone, and a trade approved without reading the preview defeats the design.
4. **Do we expose per-membership caps in the group builder at v1?** Recommended default: **no** (`19` covers the model). Groups with per-account overrides are a second sizing basis, and one basis is already the subtlest part of the product.

## Phase hints

- The **trade ticket and confirmation preview must be built together, in the phase that first sends a real order.** A ticket without a preview should never exist, not even briefly, because whatever ships first is what someone will trade with.
- **`<Money>`, the formatter and the market-precision plumbing (F6)** are first-phase foundations - retrofitting them means touching every screen.
- **Accounts, add-account and the reconciliation panel (F5)** ship in the onboarding phase, including both disclosure notes; they are text, and they prevent the two most likely failures.
- **Execution progress and the report (F4)** ship with the fan-out engine. The report is not a reporting feature; it is the engine's user interface.
- **Analytics screens (`14` F3) come later**, but the blotter is early - it is the screen that answers "what happened" during the staged rollout (`18`).
- The **U2 test** (preview equals sent) belongs in the same phase as the preview, and it is the single most valuable UI test in the plan.

## Sources

- `07-api-key-security.md` - F9 onboarding validation and the typed-versus-real balance reconciliation; F1's verified facts behind both disclosure notes, including that IP binding attaches to the key-generating device's IP.
- `08-fanout-execution-engine.md` - F3 gate refusal reasons, F4 pipeline and preview freshness, F7 execution report, F8 the 60-second abandonment rule, open question 3 on retry semantics.
- `09-sizing-allocation-rounding.md` - F5 refusal codes and F6/F7 the live numbers used in the wireframes (`BTCINR` ask 80,77,476, `max_quantity_market` 0.0158 BTC, Rs 100 `min_notional`, `DOGEINR` precision 0), and the order-book price basis.
- `10-multi-currency-inr-usdt.md` - F1 asset coverage behind the coin picker's market hints; F7 round-trip cost behind the spread warning.
- `11-positions-ledger-pnl.md` - estimated TDS labelling; dust presentation.
- `13-charting-live-market-data.md` - chart placement, and V4 (no browser requests to CoinDCX) behind U10.
- `14-analytics-product-spec.md` - F3 screens, F4 layouts, metric ids referenced in the report, and N8 (never render a missing slippage as zero).
- `19-accounts-groups-data-model.md` - the account and group entities behind the accounts and group-builder screens, and per-membership overrides.
- No external UX sources were used; every number in the wireframes traces to a live measurement recorded in `09` or `10`.

