# 05 - CoinDCX WebSockets (Spot and Futures)

Status: 2026-09-03 · track: market-data + private-event transport · scope: the complete, verified wire contract for both CoinDCX socket hosts — hosts, transport, join/leave/auth protocol, every public and private channel, and the capacity consequences for a 100-account fan-out.

Money representation assumed by this doc: **every price, quantity, balance and fee on these sockets is carried either as a decimal STRING or as a JSON number in arbitrary notation (including exponent form, e.g. `3.1e-7`, `7.009e-9`). Nothing here may be parsed into a JS `number`.** Strings go straight into a decimal type. JSON-number fields must be recovered from the raw frame text by a decimal-aware parser (`json-bigint`-style, or a regex-scoped re-extraction) because `JSON.parse` has already destroyed precision by the time you read the value. See `09-sizing-allocation-rounding.md`.

---

## Verdict

- **Use one socket connection per API key for private data, and treat that as non-negotiable.** The private channel name is the literal constant `"coindcx"` for every user on both hosts, and `order-update` / `trade-update` / `df-order-update` / `df-position-update` payloads contain **no account identifier whatsoever**. Even if the server permitted two keys to authenticate on one connection, the events would be unattributable. Capacity model: 100 accounts = 100 private sockets minimum (spot), possibly 200 (spot + futures) — see F5.
- **Market data needs at most one extra connection, not one per account.** Public channels are unauthenticated and shared. `wss://stream.coindcx.com` serves **both** futures and spot channels (VERIFIED by probe), so a single market-data socket can cover everything. Never fan market data out per account.
- **`response.data` is a JSON-encoded STRING, not an object.** Every event on both hosts arrives as `{"event":"<name>","data":"<stringified JSON>"}`. The docs render `data` as a nested object and every doc sample is therefore wrong about the type. You must `JSON.parse` twice. This single fact would break a naive implementation on day one.
- **Authentication failure is a silent disconnect.** A bad `apiKey`/`authSignature` produces socket.io packet `41` (DISCONNECT) and a closed connection with **no error event and no message** (VERIFIED, both hosts). A revoked key is indistinguishable from a network blip at the socket layer. Validate keys over REST and classify "disconnect within 2s of emitting `join(coindcx)`" as an auth failure.
- **Sockets are a latency optimisation, never the source of truth.** Wrong channel names are silently accepted and produce nothing forever; `leave` is unacknowledged on spot; documented fields (`f`, `e`, `x` on `trade-update`; `V`, `Q` on spot candles) are absent or blank on the wire. Every order must still reach a terminal state via REST polling and reconciliation (`12-order-state-reconciliation.md`).
- **Two exploitable guarantees do exist**: spot depth `vs` is a **gapless** per-market sequence (VERIFIED: 170 consecutive values over 170 s, zero gaps), and the spot candle `x` flag flips `true` exactly once per bar at the bar boundary (VERIFIED across 3 bars). Both are usable as drop detectors.

---

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Client library | `socket.io-client` v4.x, pinned exact | Both hosts run an Engine.IO v4 server with `allowEIO3` on — VERIFIED by handshake probe; v4 is maintained, v2.4.0 is EOL | `socket.io-client@2.4.0` as the Setup section instructs (line 700). Works, but abandons 4 years of fixes |
| Transport option | `transports: ["websocket"]` only, `upgrade: false` | HTTP long-polling is **broken** on both hosts: the handshake succeeds, the next poll returns `{"code":1,"message":"Session ID unknown"}` (VERIFIED). Multi-replica behind istio-envoy with no sticky cookie | Default socket.io transport list (polling→upgrade). Would fail the first poll and look like a flaky network |
| Private connection topology | 1 socket per API key per product | Private payloads carry no account id; multiplexing is unattributable | Shared authenticated socket with many `join(coindcx)` emits |
| Market-data host | `wss://stream.coindcx.com` (one connection, both products) | Serves `-futures` channels *and* unsuffixed spot channels (VERIFIED: `B-BTC_USDT@prices` on this host returned `pr:"spot"`) | Two market-data sockets (`stream-spot` + `stream`). Keep as the documented-only fallback |
| Price feed for the trading UI | `currentPrices@spot@1s` (keyed by symbol) + `{pair}@trades` | `{pair}@prices` / `price-change` carries **no symbol field** — two pairs on one socket are undemuxable (VERIFIED with BTC+ETH interleaved) | `{pair}@prices` per pair. Only safe at one pair per connection |
| Order-book source | `{pair}@orderbook@20` (spot), `@50-futures` (futures); consume `depth-snapshot`, ignore `depth-update` | One channel emits both events; snapshot is self-contained and honours the requested depth (VERIFIED 20/20 and 50/50) | Maintaining a book from `depth-update` diffs. Possible (`vs` is gapless) but buys nothing for our use case |
| Candle source | Spot: `{pair}_{res}` with `x` as the close flag. Futures: `{instrument}_{res}-futures` | Spot has a reliable closed-bar flag; futures has none | Trusting futures candles for bar-close logic |
| Truth for order state | REST polling + reconciliation; socket is a fast path only | Silent disconnects, no ack on join, absent documented fields | Socket-only order state |
| Money parsing | Decimal-aware parse of the raw frame; `JSON.parse` for structure only | Wire contains `3.1e-7` and `7.009e-9` as JSON numbers | `JSON.parse` + `Number` |

---

## Findings

### F0. Evidence base and how to reproduce

Two independent sources, both cited per claim below:

1. **The local docs file** `C:/Users/anand/Tradex/research/_sources/coindcx-docs.txt`, read in full for lines **6230–7778** (Spot Sockets) and **13321–13898** (Futures Sockets), plus Setup (651–714), Authentication (1278–1403), Terminology (551–650) and FAQ/Errors (13899–14111). Cited as `docs:LINE`.
2. **Live probes run 2026-09-03 17:42–18:17 UTC** from this box using Node v24.15.0's built-in `WebSocket` global, speaking Engine.IO v4 by hand (no dependency installed). Read-only: public channels only, plus negative auth tests using deliberately invalid credentials. No order was placed; no real API key was used. Cited as `PROBE`.

Everything tagged VERIFIED below was read in the docs file or observed on the wire. Everything tagged UNVERIFIED names the experiment that settles it.

### F1. Hosts and transport

| Item | Value | Tag | Source |
|---|---|---|---|
| Spot socket host | `stream-spot.coindcx.com` | VERIFIED | docs:6238, 6267 (`https://`), docs:6322 and 14 further sites (`wss://`) |
| Futures socket host | `stream.coindcx.com` | VERIFIED | docs:13374, 13415, 13832 (`wss://`) |
| Scheme in docs | Both `https://` and `wss://` appear for the same spot host | VERIFIED | `https://` at docs:6238/6267; `wss://` everywhere after docs:6322 |
| Path | `/socket.io/` (socket.io default) | VERIFIED | PROBE — handshake at `/socket.io/?EIO=4&transport=websocket` |
| Transport | socket.io over WebSocket. Docs pass `transports: ['websocket']` in **every** example | VERIFIED | docs:6241, 6270, 6373, 13377, 13418 |
| Engine.IO protocol accepted | **Both v4 and v3** (`EIO=4` and `EIO=3` handshakes return 200 + sid) | VERIFIED | PROBE |
| Long-polling transport | **Broken.** Handshake 200, then `{"code":1,"message":"Session ID unknown"}` on the next request, with or without a cookie jar. No sticky cookie is set | VERIFIED | PROBE |
| Upstream (spot) | `app-socket-publisher.socket.svc.cluster.local:4200` via `server: istio-envoy` | VERIFIED | PROBE (`x-envoy-decorator-operation` header) |
| Upstream (futures) | `svc-sockets-publisher-default.socket.svc.cluster.local:4200` | VERIFIED | PROBE |
| Alternative to socket.io | None. "CoinDCX Websockets are currently implemented via Socket.io. This is the only officially supported library" | VERIFIED | docs:14041-14042 |

**Engine.IO handshake parameters — these differ per host and are load-bearing:**

| Host | pingInterval | pingTimeout | maxPayload | Tag |
|---|---|---|---|---|
| `stream-spot.coindcx.com` | 45 000 ms | 60 000 ms | 1 000 000 B | VERIFIED (PROBE) |
| `stream.coindcx.com` | **25 000 ms** | **20 000 ms** | 1 000 000 B | VERIFIED (PROBE) |

The futures host is nearly 3× stricter. A client that survives on spot can be reaped on futures. The server initiates the Engine.IO heartbeat (packet `2`); the client must answer `3` within `pingTimeout`. `socket.io-client` does this automatically — the docs' 25-second application-level `ping` emit (docs:7645, 13849) is a *separate*, application-layer event and is **not** the Engine.IO heartbeat.

**Cross-host channel service (this is the finding that shrinks our connection count):**

| Attempted on | Channel | Result | Tag |
|---|---|---|---|
| `stream.coindcx.com` (futures) | `B-BTC_USDT@prices` (spot-style, unsuffixed) | Delivered `price-change` with `pr:"spot"` | VERIFIED (PROBE) |
| `stream-spot.coindcx.com` (spot) | `B-BTC_USDT@prices-futures`, `@trades-futures`, `currentPrices@futures@rt` | **Nothing.** Silent, no error, no data in 15 s | VERIFIED (PROBE) |

So `stream.coindcx.com` is a superset host for *public* data. Whether it is also a superset for *private* data is the single most valuable open experiment — see F5 and Open Questions.

### F2. The socket.io client-version contradiction (live, unresolved in the docs)

The docs contain three mutually inconsistent instructions:

| Location | Claim | Line |
|---|---|---|
| Setup → For Sockets → Javascript | "Socket.io: Please note **only version 2.4.0** of this module would work with our Websockets. Please check this version in package.json" | **docs:700** |
| Spot Sockets → first JS example, trailing comment | "These examples have been tested with the following socket.io version: // 1. **socket.io-4.x.x.js**" | **docs:6295-6296** |
| Futures Sockets → ACCOUNT → JS example, trailing comment | "// NOTE : Need to use **V2 Socket.io-client**" | **docs:13449** |

Every other spot example hedges with "Make sure you are using a version of socket.io-client that supports the features you need" (14 occurrences, e.g. docs:6540) — which resolves nothing.

**Settled empirically.** The server accepts `EIO=4`, `EIO=3` and `EIO=2` handshakes, all returning 200 with a session id (VERIFIED, PROBE). `EIO=3` and `EIO=2` responses use the v3 length-prefixed polling framing (`118:0{...}`), `EIO=4` uses the v4 framing (`0{...}`). That is the signature of an **Engine.IO v4 server with `allowEIO3: true`** — a v4 server that keeps backward compatibility. Consequence:

- `socket.io-client@4.x` works. All probes in this document used the v4 protocol by hand and received live data on both hosts.
- `socket.io-client@2.4.0` also works, via the compatibility path.
- **docs:700 and docs:13449 are stale.** Pin v4.
- The compatibility mode is a server *setting*, not a contract. If CoinDCX drops `allowEIO3` any v2 client dies instantly. This is an argument for v4, not against it.

### F3. Wire protocol: join, leave, heartbeat, errors

Everything is a socket.io event on the default namespace `/`.

**Emit — `join`** (docs:6252-6256, 6337, 6663, 13392, 13859; PROBE)

| Field | Type | Required | Notes |
|---|---|---|---|
| `channelName` | string | yes | The only key for public channels |
| `authSignature` | hex string | private only | HMAC-SHA256, see F4 |
| `apiKey` | string | private only | |

Frame on the wire: `42["join",{"channelName":"B-BTC_USDT@trades"}]`.

**Emit — `leave`** (docs:6249, 6291, 13402): `42["leave",{"channelName":"..."}]`.

**Emit — `ping`** (docs:7645, 13849): `42["ping",{"data":"Ping message"}]` every 25 s. The docs say "Ping check is required to keep the socket connection alive" (docs:7771). No server response to this event was observed (PROBE). Send it anyway — it is cheap, and it is the only documented liveness instruction.

**Observed protocol behaviour (all VERIFIED by PROBE):**

| Behaviour | Result | Consequence |
|---|---|---|
| `join` ack | **None on spot.** No ack, no error, no confirmation event | You cannot know a subscription succeeded except by receiving data |
| `join` with a nonexistent channel name | Silently accepted. Zero events, forever. Tested `THIS_CHANNEL_DOES_NOT_EXIST_xyz`, `B-ETH_USDT_1m-future`, `currentPrices@futures@1s`, `B-BTC_USDT_5m` | A typo is a silent, permanent outage of that feed. Assert first-data-within-N-seconds per subscription |
| `join` the same channel twice | **Idempotent.** Event rate did not increase (39 → 25 events per 6 s window, i.e. no doubling) | Re-joining after reconnect is safe; no dedupe needed |
| `leave` on spot | Works — flow stopped, zero events after. **No acknowledgement** | |
| `leave` on futures | Works, **and** emits an undocumented event named **`Left Channel`** | Handle it or it hits your unknown-event path |
| `leave` a never-joined channel | No error | |
| Unknown event name (`subscribe`) | Ignored, no error | |
| Channels per socket | **≥300 verified.** 300 `@trades` channels joined in one batch on one connection; 2 085 events / 30 s across 117 distinct symbols, no disconnect, no rate limit | One market-data socket is enough |
| Concurrent connections from one IP | **≥25 verified.** 25 simultaneous sockets, all handshaked, 0 errors, 6 062 events / 9 s | Real ceiling UNVERIFIED — see Open Questions |
| Engine.IO heartbeat | Server sends `2` at `pingInterval`; client must reply `3` | Handled by socket.io-client |

**Connection/error events named in the docs:**

| Event | Where | What the docs say |
|---|---|---|
| `connect` | docs:6252-6256, 6280-6287 | Emit your `join` calls from inside this handler — mandatory, because reconnects need re-joining |
| `connect_error` | docs:6258-6260 | Python-only example; prints "The connection failed!". No payload documented |
| `disconnect` | — | **Never mentioned in the docs.** It is the one you actually need (see F4) |
| `"packet queue is empty, aborting"` | docs:14074-14076 | "This happens when connection with the socket is lost. In this case please connect with the socket again and re-join the channel." The only reconnect guidance in the entire document |

HTTP error codes (docs:14077-14111) are 400/401/404/429/500/503 — these are REST codes and **no socket-specific error code, error event, or rate-limit response is documented anywhere**.

### F4. Private channel authentication

Identical construction on both hosts (docs:6325-6339 spot python, docs:6380-6394 spot JS, docs:13381-13392 futures python, docs:13425-13437 futures JS):

```
channelName = "coindcx"                       // literal constant, same for every user
body        = { "channel": "coindcx" }        // note the key is "channel", NOT "channelName"
payload     = JSON.stringify(body)            // must be {"channel":"coindcx"} with NO whitespace
signature   = HMAC_SHA256(payload, apiSecret).hexdigest()
emit("join", { channelName: "coindcx", authSignature: signature, apiKey: apiKey })
```

Points that will bite:

| Point | Detail | Tag |
|---|---|---|
| The signed body key is `channel`, the emit key is `channelName` | `{"channel":"coindcx"}` is signed; `{channelName:"coindcx", ...}` is emitted. Different key names for the same value | VERIFIED docs:6330-6337 |
| Serialisation must be compact | Python uses `json.dumps(body, separators=(',',':'))` (docs:6331) — explicit no-space separators. JS `JSON.stringify` already produces `{"channel":"coindcx"}` | VERIFIED docs:6331 |
| No timestamp in the signature | Unlike REST, which mandates a `timestamp` in the signed body (docs:1282), the socket signature covers a **constant string**. The signature is therefore static per API secret and never expires | VERIFIED docs:6330-6332 |
| Consequence of a static signature | The same `authSignature` is replayable forever. It is a bearer credential equivalent to the API secret's authority over the private feed. Treat it as a secret; never log it; never send it to a browser. See `07-api-key-security.md` | VERIFIED (inference from the above) |
| `Buffer.from(JSON.stringify(body)).toString()` in the JS sample | A no-op round-trip; the payload is just the JSON string | VERIFIED docs:6381 |
| Auth is per-`join`, not per-connection | Credentials ride in the `join` payload, not in the handshake query or headers | VERIFIED docs:6337 |
| Only private channels need auth | "Only Private channels need authentication." | VERIFIED docs:7773 |

**Failure behaviour — VERIFIED by PROBE on both hosts, and documented nowhere:**

| Attempt | Server response |
|---|---|
| `join {channelName:"coindcx"}` with **no** auth fields | Silently ignored. Connection stays open, no data, no error |
| `join {channelName:"coindcx", apiKey:"not-a-real-key", authSignature:<hmac over the correct body with a wrong secret>}` | Server sends socket.io packet **`41` (DISCONNECT)** ~100 ms later, then the connection closes. **No error event. No message. No reason.** |
| Same, with the signature computed over a *wrong* body | Connection already gone from the previous failure |

This is the most dangerous operational property of the whole interface. A revoked, IP-bound, mistyped or wrongly-encrypted key yields exactly the same observable as a transient network drop: a close. A naive reconnect loop will hammer the endpoint forever while the operator sees "reconnecting…". Required mitigations are in Failure modes.

### F5. Is one socket per API key required for private data?

**What the docs say — quoted in full, because the parent track depends on it.**

The private channel name is the literal string `coindcx` for every user, on both hosts:

- docs:6430 — "Channel: coindcx (Private)."  (balance-update)
- docs:6584 — "Channel: coindcx (Private)."  (order-update)
- docs:6759 — "Channel: coindcx (Private)."  (trade-update)
- docs:13500, 13561, 13598 — "Channel: coindcx"  (df-position-update, df-order-update, balance-update)

The FAQ's only statement on the subject (docs:14038-14040): *"Are there private channels on CoinDCX Websockets? How do I access them? — Publicly available data like market data and order book are available on public channels. On private channels, user specific information like New orders, order updates, user balance update are available. These can be accessed post authentication via API key and secret."*

On multiple keys (docs:13909-13910): *"Can a user have multiple Key and Secret — Yes, there are no restriction on creating Key and Secret."*
And (docs:13918-13919): *"Since all API users have the same level of permissions, API keys are interchangeable. However in case you choose to bind API keys with IP addresses, you might need to create a different API key for every user."*

**The docs never state a connection limit, never state whether two API keys may authenticate on one connection, and never state what happens if they try.** That is the whole of the ground truth.

**The answer is nevertheless forced, by the payloads.**

| Private event | Fields that could identify the account | Verdict |
|---|---|---|
| spot `balance-update` | `id` — docs:6438 claims "Numeric user ID as string" | Claim is **UNVERIFIED and implausible**: the row is per-currency and also carries `currency_id`, so `id` is far more likely a balance-row id. The futures sample uses the placeholder `"id":"12345"` (docs:13586) |
| spot `order-update` | `id` = order id, `client_order_id` = ours | **No account field.** `client_order_id` is the only hook, and only for orders *we* placed with a key we generated |
| spot `trade-update` | `o` order id, `t` trade id, `c` client order id | **No account field** |
| futures `df-order-update` | `id`, `group_id`, `metatags` | **No account field** |
| futures `df-position-update` | `id` = position id, `pair` | **No account field** |

So: even in the best case where the server permits it, a multiplexed private socket delivers order and position events you cannot attribute to an account. For a product whose stated requirement is "no wrong size / no silent divergence" across up to 100 accounts, unattributable fills are disqualifying.

**Decision: one authenticated socket per API key.** Not because the docs demand it — they are silent — but because the payload schema makes any other topology unsound.

**Capacity model** (Tradex target: 100 accounts per customer):

| Quantity | Value | Basis |
|---|---|---|
| Private sockets, spot only | 100 | 1 per key |
| Private sockets, spot + futures if the hosts are separate | 200 | 1 per key per host |
| Private sockets, spot + futures if `stream.coindcx.com` serves both private feeds | 100 | **UNVERIFIED — the top experiment** |
| Market-data sockets | 1 | ≥300 channels per socket verified |
| Verified concurrent-connection floor from one IP | ≥25 | PROBE |
| Concurrent-connection ceiling from one IP | **UNVERIFIED** | See Open Questions |

If the ceiling is below 100, the fan-out must be sharded across egress IPs — which collides with CoinDCX's optional IP-binding feature (docs:669 and 675: an IP-bound key "can only be used with the binded IP"). Resolve the ceiling before choosing an egress topology; it is an architecture-level input, not a tuning knob.

### F6. The envelope — `data` is a JSON string

Every event on both hosts, public and private, arrives as:

```
42["<eventName>",{"event":"<eventName>","data":"<JSON text>"}]
```

Observed verbatim (PROBE, spot `new-trade`):

```json
{"event":"new-trade","data":"{\"T\":1788457449084,\"p\":\"81090.88000000\",\"q\":\"0.00009000\",\"m\":1,\"s\":\"B-BTC_USDT\",\"pr\":\"spot\"}"}
```

VERIFIED for: `new-trade`, `price-change`, `candlestick`, `depth-snapshot`, `depth-update`, `currentPrices@spot#update`, `currentPrices@spot#snapshot`, `priceStats@spot#update`, `priceStats@spot#snapshot`, `currentPrices@futures#update` — i.e. every channel reachable without credentials, on both hosts. UNVERIFIED for the five private events (needs a key), but the envelope is produced by the same publisher process, so assume identical and assert it at runtime.

The docs show `data` as a nested object in **every** response block (docs:6410, 6547, 6739, 6864, 7020, 7137, 7256, 7366, 7481, 7590). All of them are wrong about the type. The reason nobody noticed: the docs' own handler is `console.log(response.data)`, which prints a JSON string indistinguishably from an object at a glance.

Two further envelope facts:

- The event name is duplicated — once as the socket.io event, once as `envelope.event`. Trust the socket.io name; `envelope.event` matched it in every observation.
- The **futures** response blocks in the docs omit the envelope entirely and show only the inner value (docs:13470 shows a bare `[{...}]` for `df-position-update`). The envelope is present on the wire regardless.

---

### Private channels — one subsection per event

All five private events use the same join: `emit("join", {channelName:"coindcx", authSignature, apiKey})`. There is no per-event subscription; authenticating the channel enrols you in all events that host publishes.

#### P1. `balance-update` — spot host

Request

| Field | Value |
|---|---|
| Host | `wss://stream-spot.coindcx.com` |
| Channel | `coindcx` (private) |
| Event | `balance-update` |
| Trigger | "whenever there is a change in wallet balance" (docs:6434) |
| Payload shape | `data` is an **array** of currency rows |

Response — docs:6410-6428, field notes docs:6438-6446

| Field | Doc type | Observed type | Meaning | Notes |
|---|---|---|---|---|
| `id` | "Numeric user ID as string" | UNVERIFIED | claimed user id | Almost certainly a balance-row id. Sample `"16248266"` |
| `currency_id` | "Numeric id as string" | UNVERIFIED | currency id | Sample is a **UUID** `"665d22c0-c179-4001-ae00-dd09c3ea5a24"`, contradicting "numeric" (docs:6420 vs docs:6440) |
| `currency_short_name` | string | — | `"BTC"`, `"LTC"`, `"INR"`, `"USDT"` | The only field usable as a stable key |
| `balance` | string | — | usable balance | `"0.0000000000000025"` — decimal string, 16 dp. Parse as decimal |
| `locked_balance` | string | — | "balance currently being used by an open order" | decimal string |

- The REST equivalent `POST /exchange/v1/users/balances` returns a **different shape**: `{currency, balance, locked_balance}` with `balance` as a **JSON number** `1.167` (docs:1492-1499). The socket's string form is the *safer* source; the REST float form must be re-extracted from raw text. Cross-reference `01-coindcx-spot-rest.md`.
- No `pair`, no market, no product tag. Balances are account-wide.
- Whether every currency is sent on each change, or only the changed rows, is **UNVERIFIED**. Experiment: place a 1-rupee limit order far from the market, capture the frame, count rows, compare with the REST balance list length.

#### P2. `order-update` — spot host

Request: host `wss://stream-spot.coindcx.com`, channel `coindcx`, event `order-update`. Trigger: "whenever there is a change in order status" (docs:6586). `data` is an **array** of order objects.

Response — docs:6544-6572, field notes docs:6592-6638

| Field | Wire type in the doc sample | Meaning | Implementer notes |
|---|---|---|---|
| `id` | string `"816591689"` | exchange order id | docs:6592 "Now a numeric string" — it was numeric historically. Store as string |
| `client_order_id` | string | our idempotency handle | Max 36 chars (docs:14014-14015). Sample is 55 chars (`"4f955f9c...._1783427264461276726"`) — **the sample violates the documented limit**; the exchange evidently appends a suffix. Do not assume your submitted value comes back unmodified |
| `market` | string `"PEIPEIUSDT"` | symbol = `coindcx_name`, **not** `pair` | Demux via `markets_details` |
| `order_type` | string `"limit_order"` | | Enums at docs:613-621 |
| `side` | string `"buy"`/`"sell"` | | |
| `status` | string `"filled"` | see docs:563-596 | Terminal set: `filled`, `partially_cancelled`, `cancelled`, `rejected`. Open set: `init`, `open`, `partially_filled` (docs:581-596) |
| `total_quantity` | **JSON number** `850460666` | ordered quantity | Precision hazard |
| `remaining_quantity` | **JSON number** `0` | unfilled quantity | |
| `cancelled_quantity` | **JSON number** `0` | | |
| `avg_price` | **JSON number** `7.009e-9` | avg execution price | **Exponent notation on the wire.** `JSON.parse` → float. Must be recovered from raw text |
| `price_per_unit` | **JSON number** `7.007e-9` | the limit price | Same hazard |
| `stop_price` | **JSON number** `0` | 0 for regular orders | |
| `fee` | **JSON number** `0.2` | fee **percentage** | docs:13978: `fee` is the percentage, `fee_amount` the absolute |
| `fee_amount` | **JSON number** `0.011921757615988` | absolute fee, "in base-currency" (docs:6604) | |
| `maker_fee` / `taker_fee` | **JSON number** `0.2` | percentages | |
| `time_in_force` | string | "just contains one value for now, which is `good_till_cancel`" (docs:6634) | |
| `base_currency_short_name` / `target_currency_short_name` | string | `"USDT"` / `"PEIPEI"` | |
| `base_currency_name` / `target_currency_name` | string | `"Tether"` / `"PeiPei"` | |
| `base_currency_precision` / `target_currency_precision` | number | `12` / `0` | Precision travels with the event — useful for validating our own rounding |
| `created_at` / `updated_at` | number, **ms** | `1783427264458` | docs:6636-6638 |

- **No account identifier.** This is the payload that forces one-socket-per-key (F5).
- No `trades` array on spot (futures has one — see P4).
- Whether a `market_order` also arrives here, and whether `init`/`untriggered` transitions are emitted, is **UNVERIFIED**. Experiment: place a 1-rupee `limit_order` at 50 % below market on `B-BTC_USDT` (satisfying `min_notional`), capture every frame from submit to cancel, and diff the status sequence against `POST /exchange/v1/orders/status`.

#### P3. `trade-update` — spot host

Request: channel `coindcx`, event `trade-update`. Trigger: "whenever trades are executed" (docs:6761). `data` is an **array**.

Response — docs:6736-6750, field notes docs:6767-6787. Single-letter keys, entirely different convention from `order-update`.

| Key | Doc meaning | Sample | Notes |
|---|---|---|---|
| `o` | order id | `"1364450937"` | docs:6767 "(order ID) is now numeric" — delivered as a string |
| `c` | client order id | `"ef408993...._1785872642180310917"` | again longer than 36 chars |
| `t` | trade id | `"334313822"` | string |
| `s` | "symbol/market (USDTINR)" | `"BTCUSDT"` | `coindcx_name` form |
| `p` | price | `"64407.39"` | **string** — good |
| `q` | quantity | `"0.00018"` | **string** — good |
| `T` | timestamp | `1785872642355` | ms |
| `m` | "whether the buyer is market maker or not" | `false` | boolean here; **`new-trade` uses `0`/`1` for the same concept** |
| `f` | fee amount | **ABSENT from the sample** | documented docs:6783, not in docs:6739-6750 |
| `e` | exchange identifier | **ABSENT from the sample** | documented docs:6785 |
| `x` | status | **ABSENT from the sample** | documented docs:6787 |

Three documented fields are missing from the docs' own example. UNVERIFIED whether they appear on the wire. Experiment: capture a real fill and enumerate keys; if `f` is absent, fee must come from `order-update.fee_amount` or REST trade history.

#### P4. `df-order-update` — futures host

Request: host `wss://stream.coindcx.com`, channel `coindcx`, event `df-order-update` (docs:13395-13396, 13504). `data` is an **array**.

Response — docs:13521-13556

| Field | Sample | Notes |
|---|---|---|
| `id` | `"ff5a645f-84b7-4d63-b513-9e2f960855fc"` | **UUID**, unlike spot's numeric string |
| `pair` | `"B-ID_USDT"` | **`pair` form**, unlike spot `order-update.market` which is `coindcx_name` |
| `side` / `status` | `"sell"` / `"cancelled"` | `untriggered` "only applies to Futures Take Profit and Stop Loss orders" (docs:579) |
| `order_type` | `"take_profit_limit"` | Futures-only enum absent from the spot list |
| `stop_trigger_instruction` | `"last_price"` | |
| `notification` | `"email_notification"` | |
| `leverage` | `1` | |
| `maker_fee` / `taker_fee` | `0.025` / `0.075` | percentages, different scale from spot's `0.2` |
| `fee_amount`, `price`, `stop_price`, `avg_price` | JSON numbers | Spot calls the limit price `price_per_unit`; futures calls it `price` |
| `total_quantity`, `remaining_quantity`, `cancelled_quantity` | JSON numbers | |
| `ideal_margin` | `0` | |
| `order_category` | `"complete_tpsl"` | |
| `stage` | `"tpsl_exit"` | |
| `created_at` / `updated_at` | ms | |
| `trades` | `[]` | Element shape **UNVERIFIED** — never populated in the docs |
| `display_message`, `group_status`, `group_id`, `metatags` | `null` | Shapes UNVERIFIED |
| `margin_currency_short_name` | `"INR"` | **Requirement 7 lands here** — the funding currency is per order |
| `settlement_currency_conversion_price` | `89.0` | "USDT <> INR conversion price when the order is placed. This is relevant only for INR margined Orders" (docs:9359-9360). See `10-multi-currency-inr-usdt.md` |

#### P5. `df-position-update` — futures host

Request: channel `coindcx`, event `df-position-update` (docs:13453). `data` is an **array**.

Response — docs:13470-13496

| Field | Sample | Notes |
|---|---|---|
| `id` | `"571eae12-236a-11ef-b36f-83670ba609ec"` | UUID v1 |
| `pair` | `"B-BNB_USDT"` | `pair` form |
| `active_pos` | `0` | signed position size. Sign convention **UNVERIFIED** (long positive / short negative not stated) |
| `inactive_pos_buy` / `inactive_pos_sell` | `0` | quantity locked in resting orders |
| `avg_price` | `0` | entry price |
| `liquidation_price` | `0` | |
| `locked_margin`, `locked_user_margin`, `locked_order_margin` | `0` | Three margin buckets, relationship between them **UNVERIFIED** |
| `take_profit_trigger` / `stop_loss_trigger` | `null` | |
| `leverage` | `10` | |
| `mark_price` | `0` | |
| `maintenance_margin` | `0` | |
| `margin_type` | `"isolated"` | |
| `margin_currency_short_name` | `"INR"` | per-position funding currency |
| `settlement_currency_avg_price` | `89.0` | Note: **`settlement_currency_avg_price`** here vs **`settlement_currency_conversion_price`** on orders. Different names for the same concept |
| `updated_at` | `1717754279737` | ms |

All numeric fields are JSON numbers. **This is the SELL/CLOSE-POSITION source of truth for futures** (requirement 5): `active_pos` is the held size. Because it is a float on the wire, "SELL ALL" must not be computed from this value — read the authoritative position over REST before sizing an exit. Cross-reference `09-sizing-allocation-rounding.md`.

#### P6. `balance-update` — futures host

Same event name and same five fields as spot (docs:13581-13591): `id`, `balance`, `locked_balance`, `currency_id`, `currency_short_name`, all strings. The futures sample uses placeholders (`"id":"12345"`, `"currency_id":"123"`) so the real `currency_id` format on this host is **UNVERIFIED** — spot delivers a UUID.

**Name collision hazard:** if one process holds an authenticated socket to each host, both emit `balance-update` with an identical shape and **nothing in the payload says which host it came from**. Tag events with the connection at the transport layer, never by inspecting the body.

### Public channels — one subsection per channel

#### C1. `{pair}_{resolution}` → `candlestick` (spot)

| Item | Value | Tag |
|---|---|---|
| Host | `stream-spot.coindcx.com`, also served by `stream.coindcx.com` | VERIFIED |
| Channel | `{pair}_{res}`, e.g. `B-BTC_USDT_1m` | VERIFIED docs:6895 |
| Resolutions | `1m`, `15m`, `1h`, `1d` **only** | VERIFIED docs:6891; PROBE: `_15m` delivers, `_5m` and `_4h` deliver nothing |
| Cadence | ~every 2 s while the bar is open | VERIFIED PROBE (22 events / 45 s) |
| Demuxable | **Yes** — payload carries `channel` and `i` | VERIFIED PROBE |

Response — docs:6861-6884, field notes docs:6903-6943. Live frame (PROBE):

```json
{"t":1788457500000,"T":1788457559999,"f":0,"L":0,"o":"81078.58000000","c":"81053.41000000",
 "h":"81078.59000000","l":"81041.04000000","v":"10.21132000","n":2307,"q":"827723.21095270",
 "B":"0","i":"1m","channel":"B-BTC_USDT_1m","s":"BTCUSDT","x":false,"V":"","Q":"",
 "eT":1788457544033,"ecode":"B","pr":"spot"}
```

| Key | Doc meaning | Observed | Verdict |
|---|---|---|---|
| `t` / `T` | start / close timestamp | ms; `T = t + 59999` for 1m | Bar duration = `T - t + 1` |
| `eT` | event timestamp | ms | |
| `o` `c` `h` `l` `v` `q` | open, close, high, low, base volume, quote amount | **decimal strings** | Safe to parse as decimal |
| `n` | number of trades | number `2307` | Docs' sample shows `null` (docs:6876) — the real feed populates it |
| `x` | "current candle has been completed Y/N" | boolean. **Flips `true` exactly once per bar, at the bar boundary** | VERIFIED PROBE across 3 consecutive bars: `t=...060000 x=true` then 2 s later `t=...120000 x=false n=2`. **Use this as the closed-bar signal** |
| `i` | candle period | `"1m"` | |
| `channel` | channel name | `"B-BTC_USDT_1m"` | Demux key |
| `s` | symbol | `"BTCUSDT"` — `coindcx_name`, **not** `pair` | |
| `ecode` | exchange code | `"B"` | Documented (docs:6939) but **absent from the docs' sample**; present on the wire |
| `pr` | product | `"spot"` | Documented (docs:6943) but absent from the sample; present on the wire |
| `f` / `L` | first / last trade ID | Always `0` | Useless |
| `B` | "first trade ID" (a second field with the same description, docs:6937) | Always `"0"` | Useless |
| `V` | taker buy base volume | **Always `""`** | **Documented but empty. Do not build on it** |
| `Q` | taker quote amount | **Always `""`** | Same |

#### C2. `{instrument}_{resolution}-futures` → `candlestick` (futures)

Completely different shape from C1 — different key names, different units, no close flag.

| Item | Value | Tag |
|---|---|---|
| Host | `stream.coindcx.com` | VERIFIED docs:13832 |
| Channel | `{instrument}_{res}-futures`, e.g. `B-BTC_USDT_1m-futures` | VERIFIED docs:13651 |
| Resolutions | `1m`,`5m`,`15m`,`30m`,`1h`,`4h`,`8h`,`1d`,`3d`,`1w`,`1M` | docs:13647; `5m` VERIFIED by PROBE |
| Docs typo | docs:13649 writes `"[instrument_name]_1m-future"` (singular). **`-future` delivers nothing** | VERIFIED PROBE |
| Cadence | ~2/s — much chattier than spot | VERIFIED PROBE (95 events / 41 s) |
| Demuxable | **Yes** — `channel`, `i`, and per-element `pair` + `symbol` | VERIFIED PROBE |

Live frame (PROBE):

```json
{"data":[{"open":"81006.80","close":"80996.20","high":"81023.90","low":"80977.20",
          "volume":"120.153","open_time":1788458400,"close_time":1788458459.999,
          "pair":"B-BTC_USDT","duration":"1m","symbol":"BTCUSDT","quote_volume":"9732853.23420"}],
 "ecode":"B","Ets":1788458460708,"pts":1788458460779,"i":"1m",
 "channel":"B-BTC_USDT_1m-futures","pr":"futures"}
```

| Key | Notes |
|---|---|
| `data` | **Array** of bar objects (spot delivers a single bare object). Observed length 1 |
| `open` `close` `high` `low` `volume` `quote_volume` | Decimal strings. Long names, unlike spot's `o c h l v q` |
| `open_time` | **SECONDS** `1788458400` — spot uses **milliseconds**. Unit mismatch between the two hosts |
| `close_time` | **SECONDS with a fractional part**: `1788458459.999`. A float. Multiply by 1000 and round; never compare floats |
| `pair` + `symbol` | Both forms present — the only channel that gives you both |
| `duration` | `"1m"`, mirrors `i` |
| `Ets` | "event timestamp as given by TPE" (docs:13347), ms |
| `pts` | **Undocumented.** Present on the wire, ms, ≈ `Ets + 70 ms`. Probably publisher timestamp |
| **No `x` / `is_closed`** | **Futures candles have no close flag.** You must detect bar close by watching `open_time` change, or by comparing `close_time` to exchange time (and our box was measured ~1.15 s behind CoinDCX — PROBE) |

#### C3. `{pair}@orderbook@{depth}` → `depth-snapshot` + `depth-update` (spot)

One channel, **two events**. The docs present these as two sections (docs:6945, 7062) with the same channel name; they are the same subscription.

| Item | Value | Tag |
|---|---|---|
| Channel | `{pair}@orderbook@{depth}`, depth ∈ `{10, 20, 50}` | VERIFIED docs:7042, 7157 |
| `depth-snapshot` | Full book, **exactly `depth` levels each side** | VERIFIED PROBE: `@20` → 20 asks / 20 bids; `@10` → 10/10 |
| `depth-update` | **Diff.** Only changed levels; `"price":"0"` means the level was removed | VERIFIED PROBE (1–20 levels per frame; explicit `"81052.03":"0"` entries) |
| Cadence | `depth-update` ~1/s; `depth-snapshot` ~1 per 2–3 s | VERIFIED PROBE (75 updates + 31 snapshots / 76 s) |
| Demuxable across markets | Yes, via `s` | VERIFIED |
| Demuxable across depths of the same market | **NO** — no channel or depth field. Joining `@10` and `@20` for one market interleaves 10-level and 20-level snapshots on one event name, indistinguishably | VERIFIED PROBE |

Live frame (PROBE):

```json
{"vs":47726,"ts":1788457669014,
 "asks":{"81165.51":"0.67563","81165.52":"0.0009", ...20 entries},
 "bids":{"81165.5":"2.36565", ...20 entries},
 "pr":"spot","s":"BTCUSDT"}
```

| Key | Notes |
|---|---|
| `asks` / `bids` | **JSON objects keyed by price string**, value = quantity string. Not arrays — **key order is not a guaranteed sort**. Observed bids arriving best-first then descending, but you must sort explicitly |
| `vs` | Version. **Gapless per market**: PROBE over 170 s gave 170 distinct values, min 49150 max 49319, span 170, **zero gaps**. A snapshot and its matching update share one `vs`. **This is our drop detector** |
| `ts` | ms |
| `pr` | `"spot"` |
| `s` | `"BTCUSDT"` — `coindcx_name`. VERIFIED unique across all 999 markets (PROBE of `/exchange/v1/markets_details`), so it is a safe demux key — but assert uniqueness when building the map |

Two FAQ statements are **contradicted by observation**:

| FAQ claim | Line | Observation |
|---|---|---|
| "orderbook related data on CoinDCX Websockets are snapshot updates only" | docs:14029-14030 | False. `depth-update` is a diff carrying `"0"` deletions |
| "Can I only get the order book upto a certain depth (for ex: top 10 only) — This functionality is not available. Every order book update event will give a update of upto 50 recent orders" | docs:14035-14036 | False. `@10` returns exactly 10 levels, `@20` exactly 20 |

#### C4. `{instrument}@orderbook@{depth}-futures` → `depth-snapshot` + `depth-update`

| Item | Value | Tag |
|---|---|---|
| Channel | `{instrument}@orderbook@{depth}-futures`, depth ∈ `{10,20,50}` | VERIFIED docs:13694 |
| `depth-update` | **Exists but is undocumented for futures** — the docs show only `depth-snapshot` | VERIFIED PROBE |
| Snapshot depth | `@50` → 50/50, `@20` → 20/20 | VERIFIED PROBE |
| `depth-update` size | Up to 42 levels observed — larger than spot's | VERIFIED PROBE |

Live frame (PROBE) adds three fields spot lacks:

```json
{"ts":1788457866881,"vs":217385439,"asks":{...50},"bids":{...50},
 "type":"depth-snapshot","pts":1788457866881,"E":1788457865804,"pr":"futures","s":"BTCUSDT"}
```

| Key | Notes |
|---|---|
| `type` | Undocumented. Mirrors the event name — the **only** per-frame discriminator, and it exists on futures but not spot |
| `pts` | Undocumented publisher timestamp, ms |
| `E` | "event timestamp (applicable to order book data)" (docs:13351), ms. Present on `depth-update`, absent from the `depth-snapshot` frame observed |
| `vs` | Global (~217 million), not per-market and not 1-per-second. Gaplessness per market **UNVERIFIED** on futures |
| `s` | `"BTCUSDT"` — `coindcx_name`, though the futures instrument identifier everywhere else is `B-BTC_USDT` |

#### C5. `currentPrices@spot@{1s|10s}` → `currentPrices@spot#update` **and** `currentPrices@spot#snapshot`

| Item | Value | Tag |
|---|---|---|
| Channel | `currentPrices@spot@1s` or `@10s` | VERIFIED docs:7273, PROBE both |
| Invalid | `@rt`, `@60s` → nothing | VERIFIED PROBE |
| `#update` | Documented event. Fires at the channel interval. Carries **only pairs that changed** | VERIFIED PROBE: 17 updates at 10.0 s ± 0.1 s, 555–704 pairs each |
| `#snapshot` | **UNDOCUMENTED event.** Fires **every 60 s** with the **full 999-pair set** | VERIFIED PROBE: t = 45.5 s, 105.3 s, 165.4 s, 999 pairs each |

```json
{"pr":"SPOT","prices":{"BTCUSDT":81090.89,"BTTCUSDT":3.1e-7,"ADAUSDT":0.2226},
 "ts":1788457678284,"vs":7931327}
```

| Key | Notes |
|---|---|
| `prices` | Object `symbol → price`. **Prices are JSON numbers, and exponent notation appears** (`3.1e-7`). This is the one channel where the raw text *must* be parsed with a decimal-aware parser |
| `pr` | `"SPOT"` — **uppercase here**, lowercase `"spot"` everywhere else |
| `ts` / `vs` | ms / monotonic version, shared across `#update` and `#snapshot` |

Best channel for a many-symbol price display: it is symbol-keyed and therefore demuxable, unlike `price-change`. If you need full state at start-up, do **not** wait up to 60 s for `#snapshot` — bootstrap from `GET /exchange/ticker` (999 rows, prices as strings, `timestamp` in **seconds**; VERIFIED PROBE) and then apply `#update`.

#### C6. `currentPrices@futures@rt` → `currentPrices@futures#update`

| Item | Value | Tag |
|---|---|---|
| Channel | `currentPrices@futures@rt` — **only** `@rt`; `@1s`/`@10s` deliver nothing | VERIFIED docs:13741, PROBE |
| Shape | **Two different payload variants on the same event name** | VERIFIED PROBE |

Variant A — mark price (this is what the docs show, docs:13715-13738):

```json
{"vs":356976913,"ts":1788457809589,"pr":"futures","pST":1788457809568,
 "prices":{"B-LDO_USDT":{"mp":2.87559482,"bmST":1788457809000,"cmRT":1788457809149},
           "B-AVA_USDT":{"bmST":1788457809000,"cmRT":1788457809148}}}
```

Variant B — ticker, **undocumented**:

```json
{"vs":356976914,"ts":1788457809705,"pr":"futures","pST":1788457809632,
 "prices":{"B-AVA_USDT":{"v":642232.38371,"ls":0.2024,"pc":9.465,
                         "btST":1788457809009,"ctRT":1788457809605}}}
```

| Key | Meaning | Source |
|---|---|---|
| `mp` | mark price | docs:13363 |
| `ls` | last price | docs:13357 |
| `pc` | price change percent | docs:13359 |
| `v` | volume 24 h | docs:13355 |
| `bmST` | "TPE mark price send time" | docs:13365 |
| `btST` | "TPE Tick send time" | docs:13361 |
| `pST` | "price sent time" | docs:13353 |
| `cmRT` / `ctRT` | **Undocumented.** Presumably CoinDCX mark/tick receive time | PROBE |
| `prices` keys | `pair` form `B-AVA_USDT` — **unlike spot, which uses `coindcx_name`** | PROBE |

Note in Variant A, `B-AVA_USDT` has **no `mp`** — a mark-price entry with the mark price absent. Every field in this nested object is optional. All values are JSON numbers.

#### C7. `priceStats@spot@60s` → `priceStats@spot#update` **and** `priceStats@spot#snapshot`

| Item | Value | Tag |
|---|---|---|
| Channel | `priceStats@spot@60s` | VERIFIED docs:7388 |
| Invalid | `@10s` → nothing | VERIFIED PROBE |
| Actual cadence | **~10 s, not 60 s.** The `@60s` in the name does not describe the emission interval | VERIFIED PROBE (4 updates / 46 s) |
| `#snapshot` | Undocumented full-set variant, same pattern as C5 | VERIFIED PROBE |

```json
{"pr":"SPOT","stats":{"0GUSDT":{"pc":"-0.483","ts":1788426866311,"v":"768608.11082000"},
                      "AAVEINR":{"pc":"6.7483441599796204","ts":0,"v":"631380.41064"}},
 "ts":1788426878298,"vs":7428360}
```

| Key | Notes |
|---|---|
| `pc` | 24 h price change percent, **string**. USDT pairs give 3 dp (`"-0.483"`); **INR pairs give raw full-precision floats-as-strings** (`"6.7483441599796204"`) |
| `ts` (inner) | **`0` for INR pairs**, a real ms timestamp for USDT pairs. Two different pipelines behind one event |
| `v` | 24 h volume, string |

#### C8. `{pair}@trades` / `{instrument}@trades-futures` → `new-trade`

| Item | Spot | Futures |
|---|---|---|
| Channel | `{pair}@trades` (docs:7497) | `{instrument}@trades-futures` (docs:13780) |
| Demuxable | **Yes**, `s` present | **Yes**, `s` present |
| Rate | ~9/s on BTC_USDT | ~similar |

```
spot:    {"T":1788457449084,"p":"81090.88000000","q":"0.00009000","m":1,"s":"B-BTC_USDT","pr":"spot"}
futures: {"T":1788457808799,"RT":1788457893377.0894,"p":"81088.4","q":"0.003","m":1,"s":"B-BTC_USDT","pr":"f"}
```

| Key | Notes |
|---|---|
| `p` / `q` | **decimal strings.** Spot pads to 8 dp, futures does not |
| `s` | **`pair` form** here (`B-BTC_USDT`) — the opposite of `candlestick` and `depth`, which use `coindcx_name` |
| `m` | `0`/`1` **number** here; `trade-update` uses a **boolean** for the same concept |
| `pr` | **`"spot"` on spot but `"f"` on futures.** Futures `depth`/`candlestick` use `"futures"`. Three spellings of the product tag |
| `RT` | Futures only. "range timestamp" (docs:13341). **A float with sub-ms digits** (`1788457893377.0894`) and ~85 s *ahead* of `T` in observation. Meaning unclear — do not use |
| No trade id | Neither host sends a trade id on this channel. Deduplication must key on `(s, T, p, q)`, which is not unique | VERIFIED |

The docs' sample for spot shows `"m": 0` and `"s": "G-PEIPEI_USDT"` (docs:7480-7492) — consistent with observation.

#### C9. `{pair}@prices` / `{instrument}@prices-futures` → `price-change`

**The most dangerous channel in the API. Do not multiplex it.**

```
spot:    {"p":"81090.88000000","T":1788457449084,"pr":"spot"}
futures: {"T":1788457808799,"p":"81088.4","pr":"f"}
```

There is **no symbol field**. PROBE: joining `B-BTC_USDT@prices` and `B-ETH_USDT@prices` on one socket produced an interleaved stream of `81172.46` and `2503.79` frames with nothing to tell them apart. VERIFIED on both hosts.

| Consequence | Rule |
|---|---|
| Only usable at one pair per connection | If you need N live prices, use `currentPrices@spot@1s` (symbol-keyed) or `{pair}@trades` (carries `s`) |
| Doc errors in this section | docs:13815 says the futures channel is `"[instrument_name]@trades-futures"` while docs:13817 gives the example `B-ID_USDT@prices-futures`, and docs:13819 labels the Event `new-trade` when it is `price-change`. Three errors in five lines. The working name is `@prices-futures`, event `price-change` (VERIFIED PROBE). The spot equivalent is documented correctly at docs:7603 as `{pair}@prices` |
| Doc heading errors | docs:7134 labels the `depth-update` response "Get Depth Snapshot response"; docs:7587 labels the `price-change` response "Get New Trade response" |

### Channel-name grammar (the authoritative table)

`{pair}` and `{instrument}` are the **same** `B-BTC_USDT` form: `{ecode}-{target}_{base}` (docs:979). Source of truth: `GET /exchange/v1/markets_details` field `pair` for spot, `GET .../futures/data/active_instruments` for futures. PROBE: 999 spot markets across ecodes `B` (376), `KC` (244), `I` (339), `G` (40); 626 USDT-quoted, 339 INR-quoted, 27 BTC, 5 ETH, 1 USDC, 1 TRX.

| Channel name | Host(s) | Events emitted | Auth |
|---|---|---|---|
| `coindcx` | both | spot: `balance-update`, `order-update`, `trade-update` · futures: `balance-update`, `df-order-update`, `df-position-update` | **yes** |
| `{pair}_1m` `_15m` `_1h` `_1d` | spot, and `stream` | `candlestick` | no |
| `{pair}_{1m,5m,15m,30m,1h,4h,8h,1d,3d,1w,1M}-futures` | `stream` only | `candlestick` | no |
| `{pair}@orderbook@{10,20,50}` | spot, and `stream` | `depth-snapshot`, `depth-update` | no |
| `{pair}@orderbook@{10,20,50}-futures` | `stream` only | `depth-snapshot`, `depth-update` | no |
| `{pair}@trades` | spot, and `stream` | `new-trade` | no |
| `{pair}@trades-futures` | `stream` only | `new-trade` | no |
| `{pair}@prices` | spot, and `stream` | `price-change` | no |
| `{pair}@prices-futures` | `stream` only | `price-change` | no |
| `currentPrices@spot@{1s,10s}` | spot, and `stream` | `currentPrices@spot#update`, `currentPrices@spot#snapshot` | no |
| `currentPrices@futures@rt` | `stream` only | `currentPrices@futures#update` | no |
| `priceStats@spot@60s` | spot, and `stream` | `priceStats@spot#update`, `priceStats@spot#snapshot` | no |

Names verified as **invalid** (silently accepted, zero data): `{pair}_5m`, `{pair}_4h` (spot), `{pair}_1m-future` (singular), `currentPrices@futures@1s`, `currentPrices@futures@10s`, `currentPrices@spot@rt`, `priceStats@spot@10s`, any `-futures` channel on `stream-spot`.

### Gotchas

Ordered by how much damage each one does if missed.

| # | Gotcha | Consequence |
|---|---|---|
| 1 | `envelope.data` is a **JSON string**, not an object. Docs show an object everywhere | Nothing works, or worse: `data.status` is `undefined` and a filled order looks unfilled |
| 2 | Bad `apiKey`/`authSignature` → socket.io `41` + close, **no error, no message** | Revoked key = infinite silent reconnect loop |
| 3 | Wrong channel name → **silently accepted**, zero data forever | A typo is an undetectable outage |
| 4 | `price-change` has **no symbol field** | Multiplexed price feeds silently attribute BTC's price to ETH |
| 5 | Private payloads have **no account identifier** | Multiplexing keys makes fills unattributable. Forces 1 socket per key |
| 6 | `s` is `coindcx_name` (`BTCUSDT`) on `candlestick`/`depth`, but `pair` (`B-BTC_USDT`) on `new-trade` | Demux map must be bidirectional, and you must know which form each event uses |
| 7 | `pr` is `"spot"`, `"SPOT"`, `"futures"` or `"f"` depending on channel | Any equality check on product must be normalised |
| 8 | Futures candle `open_time`/`close_time` in **seconds** (close_time a `.999` float); spot in **ms** | Off-by-1000 bar alignment; float comparison bugs |
| 9 | Futures candles have **no `x`/close flag**; spot does | Bar-close logic cannot be shared between products |
| 10 | JSON numbers in exponent form on the wire (`3.1e-7`, `7.009e-9`) | `JSON.parse` silently loses precision before you can intervene |
| 11 | Same field, different name: `price_per_unit` (spot) vs `price` (futures); `settlement_currency_conversion_price` (order) vs `settlement_currency_avg_price` (position) | Mapping layers get it backwards |
| 12 | `m` is boolean on `trade-update`, `0`/`1` on `new-trade` | Truthiness bugs (`m === false` vs `m === 0`) |
| 13 | Documented-but-absent fields: `trade-update.f/e/x`; `candlestick.V/Q` always `""`; `f`/`L`/`B` always `0` | Fee from `trade-update` is not available; get it from `order-update.fee_amount` |
| 14 | `asks`/`bids` are **objects keyed by price**, not sorted arrays | Never trust key iteration order for best bid/ask |
| 15 | Two depth channels for one market are undemuxable on spot (no `channel`/depth field; futures has `type` but not depth) | Subscribe to exactly one depth per market per socket |
| 16 | `priceStats@spot@60s` actually emits every ~10 s; INR rows carry `ts:0` and full-precision `pc` | Interval in the name is not the cadence |
| 17 | Undocumented events exist: `currentPrices@spot#snapshot`, `priceStats@spot#snapshot`, futures `Left Channel`, futures `depth-update` | An unknown-event handler that throws will crash on normal traffic |
| 18 | HTTP long-polling is **broken**; default socket.io tries polling first | Default client config fails with a misleading "Session ID unknown" |
| 19 | Futures `pingTimeout` is 20 s vs spot's 60 s | A client tuned on spot gets reaped on futures |
| 20 | `client_order_id` comes back **longer than the documented 36-char max** | A strict-length validator rejects the exchange's own echo |
| 21 | Our box clock measured **~1.15 s behind** CoinDCX (PROBE, `Date` header) | Any bar-close or REST `timestamp` logic must use a server-offset estimate, not local time |
| 22 | `join` on `connect` is mandatory — subscriptions do **not** survive a reconnect | Silent permanent data loss after the first blip |

---

## Design

### D1. Connection topology for 100 accounts

```
                       Tradex socket supervisor (one process per shard)
                                       |
        +------------------------------+-----------------------------------+
        |                              |                                   |
  MARKET DATA (1 socket)        PRIVATE SPOT (N sockets)          PRIVATE FUTURES (N sockets)
  wss://stream.coindcx.com      wss://stream-spot.coindcx.com     wss://stream.coindcx.com
  no auth                       join(coindcx, sig_i, key_i)       join(coindcx, sig_i, key_i)
  >=300 channels verified       one per API key                   one per API key
        |                              |                                   |
   symbol-keyed fan-out          accountId bound at the             accountId bound at the
   to all subscribers            TRANSPORT layer, never             TRANSPORT layer
                                 from the payload
        |                              |                                   |
        +--------------+---------------+-----------------------------------+
                       |
              normaliser: JSON.parse(envelope) -> JSON.parse(envelope.data)
                          -> decimal-aware re-extraction of number fields
                          -> {accountId, product, event, payload}
                       |
              event bus  ->  order state machine  ->  reconciler (REST truth)
```

Bindings that must be structural, not inferred:

| Binding | How |
|---|---|
| socket → accountId | The supervisor owns the map. A private event's account is the socket it arrived on. **Never** read it from the body |
| socket → product | Separate connections for spot and futures even if one host serves both, so `balance-update` is never ambiguous |
| subscription → channel | Keep the joined-channel set per socket in memory; re-emit the whole set on every `connect` |

### D2. Connection state machine (per socket)

```
                    +--------------------------------------------+
                    v                                            |
  IDLE --connect()--> CONNECTING --"connect"--> JOINING --data--> LIVE
                    |                            |                |
                    | "connect_error"            | no data in     | "disconnect" /
                    | / timeout                  | joinProbe(20s) | EIO ping timeout
                    v                            v                v
                  BACKOFF <----------------- SUBSCRIPTION_SUSPECT  BACKOFF
                    |                            (alarm, re-join)
                    | attempt N
                    v
        if (private && closed within AUTH_WINDOW of emitting join(coindcx))
              -> AUTH_SUSPECT: stop reconnecting, probe the key over REST,
                 page an operator. NEVER auto-retry past AUTH_MAX attempts.
```

| Guard | Value | Why |
|---|---|---|
| `AUTH_WINDOW` | 2 000 ms | Observed: packet `41` arrived ~100 ms after the bad `join`; 2 s covers a slow link |
| `AUTH_MAX` | 3 consecutive auth-suspect closes | Then quarantine the account and alarm. An IP-bound or revoked key never recovers by retrying |
| `joinProbe` | 20 s for a liquid market, 120 s for an illiquid one | Detects gotcha #3 (typo = silence). Illiquid pairs are legitimately silent |
| Backoff | 1 s → 2 s → 4 s … cap 30 s, ±30 % jitter | 100 sockets reconnecting in lockstep after an exchange restart is a self-inflicted DDoS |
| `pingTimeout` budget | Use the **futures** figure (20 s) everywhere | Tighter of the two; a client safe on futures is safe on spot |
| App-level `ping` | every 25 s per docs:7645 | Cheap; the only documented liveness instruction |

Reconnect is not idempotent by accident — it is idempotent by verified server behaviour (duplicate `join` does not duplicate delivery, F3). Re-join everything unconditionally.

### D3. Frame decoding pipeline

```
raw WS text frame
  -> socket.io strips "42[...]"  (socket.io-client does this)
  -> envelope = arg0                            // {event, data}
  -> assert typeof envelope.data === "string"   // fail loudly if this ever changes
  -> structure = JSON.parse(envelope.data)      // structure ONLY; numbers now suspect
  -> for every money field:
        if typeof raw === "string"  -> Decimal(raw)                  // exact
        else                        -> Decimal(reExtractFromText())  // regex on envelope.data
  -> normalise product tag: {"spot","SPOT"} -> SPOT ; {"futures","f"} -> FUTURES
  -> normalise symbol: pair <-> coindcx_name via the markets_details map
  -> emit {accountId, product, event, at, payload}
```

`reExtractFromText` matters because `JSON.parse('{"avg_price":7.009e-9}')` yields a float before any of our code sees it. Scope the regex to the key: `/"avg_price"\s*:\s*(-?[0-9.eE+-]+)/`. Fields that need it, per the tables above:

| Event | JSON-number fields needing raw re-extraction |
|---|---|
| spot `order-update` | `avg_price`, `price_per_unit`, `stop_price`, `total_quantity`, `remaining_quantity`, `cancelled_quantity`, `fee`, `fee_amount`, `maker_fee`, `taker_fee` |
| futures `df-order-update` | `price`, `stop_price`, `avg_price`, `total_quantity`, `remaining_quantity`, `cancelled_quantity`, `fee_amount`, `ideal_margin`, `maker_fee`, `taker_fee`, `settlement_currency_conversion_price` |
| futures `df-position-update` | `active_pos`, `avg_price`, `liquidation_price`, all three `locked_*margin`, `mark_price`, `maintenance_margin`, `settlement_currency_avg_price` |
| `currentPrices@spot#*` | every value in `prices` |
| `currentPrices@futures#update` | `mp`, `ls`, `pc`, `v` |

Everything else on these sockets is already a decimal string and needs no rescue.

### D4. Drop detection

| Feed | Detector | Action on gap |
|---|---|---|
| spot `depth-*` | `vs` is gapless per market (VERIFIED) — track last `vs`, expect +1 | Discard the local book, wait for the next `depth-snapshot` (arrives within ~3 s) |
| futures `depth-*` | `vs` is global; gaplessness per market UNVERIFIED | Do not build a diff book on futures until measured |
| spot `candlestick` | Exactly one `x:true` per bar; bar starts every `T-t+1` ms | A bar with no `x:true` means a drop → refetch from `GET /market_data/candles` |
| futures `candlestick` | No close flag → watch `open_time` transitions | Same refetch |
| `currentPrices@spot` | `vs` increments per emission; `#snapshot` every 60 s repairs everything | Log the gap, let the 60 s snapshot heal it |
| private events | **No sequence number of any kind** | The only detector is REST reconciliation. This is why the socket can never be the source of order truth |

That last row is the crux of "no lost order" and "no silent divergence": the private feed has no gap detector, so it is an accelerator, not an authority. Order state must converge via polling; the socket only makes convergence faster in the common case. See `12-order-state-reconciliation.md` and `12-order-state-reconciliation.md`.

### D5. Charting feed selection (feeds into requirement 11)

| Need | Feed | Why |
|---|---|---|
| Historical bars | `GET /market_data/candles?pair=&interval=` (docs:13970) | Sockets deliver no history; the first socket frame is mid-bar |
| Live bar updates | spot `{pair}_{res}` with `x` as the commit signal | Only reliable close flag on the platform |
| Live last price on one chart | `{pair}@prices` is acceptable **only** on a socket dedicated to that one pair | No symbol field (gotcha #4) |
| Live prices across a watchlist | `currentPrices@spot@1s` | Symbol-keyed |
| Depth ladder | `{pair}@orderbook@20`, consume `depth-snapshot` only | Self-contained, correct depth |
| Trade tape | `{pair}@trades` | Carries `s`; no trade id, so dedupe on `(s,T,p,q)` |

Available resolutions differ by product (4 on spot, 11 on futures) — the chart's resolution picker must be driven by product, not hard-coded. Library choice is out of scope here; see `13-charting-live-market-data.md`.

---

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Revoked / IP-bound / mistyped API key | Close within `AUTH_WINDOW` of `join(coindcx)`; **no error is emitted** | `AUTH_SUSPECT` state, REST key probe, quarantine after `AUTH_MAX`, page operator | One account blind to fills; group trades still place via REST but their state lags until reconciliation |
| Channel-name typo | `joinProbe` timeout — no data within the per-market window | Fail deployment on an unknown channel name; validate every name against the grammar table at build time | One feed dark, silently, indefinitely |
| `envelope.data` type changes to a real object | Runtime assertion on `typeof envelope.data` | Decoder accepts both, alarms on the change | Total decode failure if unguarded |
| socket.io server drops `allowEIO3` | Only affects v2 clients | Pin v4 | None, if v4 is pinned |
| Default transport config (polling first) | `{"code":1,"message":"Session ID unknown"}` in logs | `transports:["websocket"], upgrade:false` | No connection at all; error message points nowhere useful |
| Reconnect without re-join | Connection healthy, zero events | Re-emit the full channel set inside the `connect` handler; `joinProbe` catches the omission | Permanent silent data loss |
| 100 sockets reconnect in lockstep | Spike in connect attempts | Jittered backoff; stagger initial connects | Possible IP-level throttling of all accounts at once |
| Concurrent-connection ceiling below 100 | Connections beyond K fail or are closed | **Measure before building** (Open Q1). Fallbacks: shard across egress IPs (conflicts with IP-bound keys), or accept REST-only for accounts beyond K | Whole product design |
| Futures `pingTimeout` (20 s) exceeded by a GC pause or event-loop stall | Repeated close/reopen with no error | Keep the decode path off the socket thread; bound per-frame work; monitor event-loop lag | Flapping private feeds |
| Float precision loss on `avg_price` / `fee_amount` | Reconciliation mismatch vs REST | Decimal re-extraction (D3); assert socket-vs-REST agreement on fill price | Wrong P&L, wrong "no wrong size" guarantee |
| Two accounts' events conflated | Would require multiplexed keys | Structurally impossible under D1 (one socket per key) | Catastrophic if allowed — wrong account credited with a fill |
| `balance-update` from two hosts conflated | Identical shape, no host tag | Bind product at the transport layer | Wrong currency balance shown; wrong % sizing for requirement 4 |
| Undocumented event (`Left Channel`, `#snapshot`) crashes the handler | Unknown-event counter | Default branch logs and counts, never throws | Process crash on routine traffic |
| Multiple depths joined for one market | Snapshot level count varies frame to frame | One depth per market per socket, enforced by the subscription registry | Corrupt depth ladder |
| Exchange clock skew (~1.15 s measured) | Compare `Date` header / event `ts` against local clock continuously | Maintain a server-offset estimate; never use local time for bar or expiry logic | REST `timestamp` rejections; mis-aligned bars |
| Silent divergence between socket state and exchange | Periodic REST reconciliation of open orders, positions and balances | Reconciler is mandatory, not optional; socket absence must never be read as "nothing changed" | The core money guarantee |

---

## Open questions for Anand

1. **Does one authenticated socket to `wss://stream.coindcx.com` deliver both spot and futures private events?** `stream.coindcx.com` provably serves spot *public* channels (VERIFIED). If it also serves the spot private events, our private connection count halves (100 instead of 200). Experiment: authenticate `join(coindcx)` on `stream.coindcx.com` with one real key, place a 1-rupee spot limit order far from the market, and watch for `order-update`. Needs one live API key on a funded account — a decision for you, not a design choice.
2. **What is the concurrent-connection ceiling per source IP?** Verified floor is 25. We need ~100–200. If the ceiling is lower, the egress topology (single IP vs sharded) becomes an architecture decision, and it interacts with CoinDCX's optional IP-binding on keys (docs:669 and 675). Do we ask CoinDCX support for the documented limit, or discover it by ramping connections on a throwaway key?
3. **Spot or futures for v1?** This document covers both because the brief said "CoinDCX only", not "spot only". The two are genuinely different systems: different hosts, different heartbeats, different candle shapes, different position model, and futures carries the INR/USDT margin fields that requirement 7 needs. Scoping v1 to **spot only** removes roughly half of this contract. Which is it?
4. **Do we use IP-bound API keys?** Binding is a real security win for requirement 9 and pins our egress, which conflicts with question 2's sharding fallback. Decide before the capacity model is fixed.
5. **Is a 20-order-per-second group fan-out inside CoinDCX's tolerance?** REST rate limits are documented (Create Order 2000/60s, docs:727-729; FAQ says 16/sec 960/min, docs:13923-13924) but **no socket rate limit is documented anywhere**. A 100-account group trade is 100 REST orders in a burst. This is a REST question — flagged here because the socket side gives no backpressure signal and will not tell us we are being throttled. Cross-reference `01-coindcx-spot-rest.md`.

---

## Phase hints

| Phase | Work | Must precede it |
|---|---|---|
| **P0 — spike, before any architecture is fixed** | Answer Open Q1 and Q2 with one real key on a small funded account. Both change the topology | Anand supplies a key; agreement that a 1-rupee probe order is acceptable |
| **P1 — market-data client** | One socket to `stream.coindcx.com`, websocket-only, v4 pinned. Channels: `currentPrices@spot@1s`, `{pair}@orderbook@20`, `{pair}_{res}`, `{pair}@trades`. Full decode pipeline (D3) including decimal re-extraction | `markets_details` symbol map (`01-coindcx-spot-rest.md`); decimal library choice (`09-sizing-allocation-rounding.md`) |
| **P2 — private-feed supervisor** | One socket per key; transport-layer accountId binding; the F4/D2 auth-failure classifier; per-socket subscription registry with re-join on connect | P0 answers; key storage and decryption (`07-api-key-security.md`) |
| **P3 — order state machine** | Consume `order-update`/`trade-update` as the fast path; REST poll as the authority; the reconciler that closes "no lost order" and "no silent divergence" | P2; order placement (`12-order-state-reconciliation.md`) |
| **P4 — group fan-out reporting** | Per-account terminal state for one logical group trade, using the socket as the accelerator and REST as the arbiter. Partial group failure surfaced as a first-class outcome | P3 |
| **P5 — charts** | D5 feed wiring; historical bootstrap from `/market_data/candles`; live commit on spot `x:true` | P1; `13-charting-live-market-data.md` |
| **P6 — futures** (only if Open Q3 says futures is in scope) | Second private socket per key; the futures decoder variants (C2, C4, C6, P4, P5); `margin_currency_short_name` and the conversion-price fields | P2; `10-multi-currency-inr-usdt.md` |
| **Continuous** | Runtime assertions: `typeof envelope.data === "string"`, `coindcx_name` uniqueness, spot `vs` gaplessness, one `x:true` per bar, unknown-event counter. Each one is a tripwire on a fact verified on 2026-09-03 that CoinDCX can change without telling us | — |

---

## Sources

**Local docs file** — `C:/Users/anand/Tradex/research/_sources/coindcx-docs.txt` (14 111 lines, converted from docs.coindcx.com). Ranges read in full for this track:

| Lines | Section |
|---|---|
| 539-650 | Introduction, Terminology (order status and order_type enums) |
| 651-714 | Setup — including the `[email protected]` instruction at 700 |
| 715-766 | SPOT API Rate Limits (REST only; no socket limits) |
| 875-1017 | Markets details — `pair` construction at 979 |
| 1278-1403 | Authentication — HMAC-SHA256 construction, `X-AUTH-APIKEY` / `X-AUTH-SIGNATURE` |
| 1406-1511 | Get balances (REST) — for the socket-vs-REST shape comparison |
| **6230-7778** | **Spot Sockets** — primary source. 6230 intro; 6314 balance-update; 6448 order-update; 6640 trade-update; 6789 candlestick; 6945 depth-snapshot; 7062 depth-update; 7181 currentPrices; 7291 priceStats; 7406 new-trade; 7515 price-change; 7617 sample code; 7768-7776 the Note block |
| 7825-7885 | Get active instruments (futures instrument names) |
| **13321-13898** | **Futures Sockets** — primary source. 13323 glossary; 13367 ACCOUNT/auth; 13453 df-position-update; 13504 df-order-update; 13565 balance-update; 13602 candlestick; 13655 orderbook; 13700 currentPrices; 13747 new-trade; 13786 LTP; 13821 sample code |
| 13899-14076 | FAQ — sockets Q&A at 14027-14043; error handling at 14074 |
| 14077-14111 | Errors — HTTP codes only |

Note on the TOC file: `coindcx-docs-toc.txt` lists `13391: # Join channel` as a section. It is not — line 13391 is the Python comment `# Join channel` inside a code block, misparsed by the converter. The Futures Sockets section runs unbroken from 13321.

**Live probes** — run from this box 2026-09-03 17:42–18:17 UTC, Node v24.15.0 built-in `WebSocket`, Engine.IO v4 spoken directly, no dependency installed. Public channels and negative auth tests with deliberately invalid credentials only; no order placed, no real key used. Endpoints touched:

| Endpoint | Purpose |
|---|---|
| `https://stream-spot.coindcx.com/socket.io/?EIO={2,3,4}&transport=polling` | Engine.IO version + polling-transport verification |
| `https://stream.coindcx.com/socket.io/?EIO={3,4}&transport=polling` | Same, futures host |
| `wss://stream-spot.coindcx.com/socket.io/?EIO=4&transport=websocket` | All spot channel probes |
| `wss://stream.coindcx.com/socket.io/?EIO=4&transport=websocket` | All futures channel probes + cross-host test |
| `https://api.coindcx.com/exchange/v1/markets_details` | `coindcx_name` uniqueness (999 markets, 0 collisions), ecode and quote-currency distribution |
| `https://api.coindcx.com/exchange/ticker` | REST bootstrap shape; clock-skew measurement via the `Date` header |

**External** — `https://socket.io/docs/v4/client-installation/` and `https://socket.io/docs/v4/engine-io-protocol/` for the Engine.IO v3-vs-v4 protocol distinction and the `allowEIO3` compatibility flag that explains why both handshakes succeed. UNVERIFIED by fetch in this session; the behavioural evidence for the conclusion is the probe result, not the doc.

**Cross-references** — `01-coindcx-spot-rest.md`, `07-api-key-security.md`, `09-sizing-allocation-rounding.md`, `10-multi-currency-inr-usdt.md`, `12-order-state-reconciliation.md`, `13-charting-live-market-data.md`.


