# Phase 11 - DEFERRED: private sockets

Status: **deferred out of v1, 2026-09-05** | reason: pure latency optimisation; nothing depends on it | depends on: 06

## Why this is deferred rather than cut

Sockets were never a correctness mechanism. Decision D20 made them a **trigger**: a socket event enqueues a poll, and the poll is what mutates state. That was deliberate, because `05` verified live that CoinDCX sockets fail silently in four distinct ways - a wrong channel name is accepted and yields nothing forever, `leave` is unacknowledged on spot, an auth failure is a bare disconnect with no error event, and several documented fields never arrive.

The consequence of that design is exactly what makes deferral safe: **if this phase never ships, the product is slower and still correct.** Order state converges through the reconciler's polling loops either way (`12` F4), which are built in Phase 06.

## What the customer loses

| With sockets | Without |
|---|---|
| Order status updates in under a second | Updates at the poll cadence - 1 s during a fan-out, so barely different |
| Balance updates pushed | Refreshed on the reconciler's 5-minute sweep, or on demand |
| Live progress feels instant | Live progress already streams from **our** server over SSE (Phase 08), driven by our own state changes |

The last row is why the loss is small. Phase 08's progress screen is fed by our database, not by CoinDCX sockets - so the customer still watches their fan-out advance in real time. The socket would only shave the gap between an exchange fill and our polling noticing it.

## What deferring saves

5-6 developer-days, plus the operational surface described in `22` F4: one socket connection per API key, so 2,000 accounts means 2,000 concurrent authenticated connections from one egress IP - with an **unverified** per-IP connection limit, jittered-reconnect requirements and a genuine thundering-herd risk on a mass drop.

That risk profile is a good reason to defer until account counts justify it. At the first-customer scale the polling cadence is indistinguishable.

## When to revive

| Trigger | Why |
|---|---|
| Poll cadence becomes the customer-visible bottleneck | The only functional reason |
| The rate-limit axis (G2) turns out to be **per IP** | Sockets would let Loop A's cadence drop, freeing REST budget - this is the strongest argument for reviving it |
| Account count passes a few hundred | Polling volume starts to matter |

Note the second row: if G2 says per-IP, this phase changes from a nicety to a capacity mitigation, because `22` F3 shows a 20-account fan-out at a 1-second Loop A cadence would consume more than the entire 960/min budget. Socket-primary with poll-on-change is listed there as a mitigation.

## Before reviving, resolve one thing

The docs contradict themselves on the client version: the Setup section says only socket.io **2.4.0** works; the Spot Sockets section says examples were tested on **4.x.x**. `research/05-coindcx-websockets.md` records both locations. Settle it empirically first - a wrong version means silent no-data, not an error.

Estimate on revival: **5-6 developer-days**, unchanged. `research/05-coindcx-websockets.md` remains complete: the per-key connection requirement, the double-parse of `data`, decimal-safe extraction of exponent-form numbers, auth-failure classification, and the `vs`/`x` liveness detectors.

## Sources

- `research/05-coindcx-websockets.md` - the full contract and the four verified failure modes
- `research/12-order-state-reconciliation.md` F2 - sockets as trigger, REST as authority
- `research/22-nonfunctional-slos-capacity.md` F3, F4 - the capacity argument for reviving, and the connection-count model
- `DECISIONS.md` D20 - sockets are a trigger, never a source of truth
