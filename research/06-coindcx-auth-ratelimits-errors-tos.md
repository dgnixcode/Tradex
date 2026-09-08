# 06 - CoinDCX auth, rate limits, pagination, errors, FAQ and API Terms

Status: 2026-09-03 · track: exchange contract ground truth · scope: the byte-exact CoinDCX request contract (signing, clock, quotas, paging, error taxonomy) plus every API Licence clause that constrains Tradex operating on other people's keys.

Money representation assumed here: every price, quantity and balance that crosses the CoinDCX boundary is a **decimal string** produced by a decimal library or an integer in minor units. Never a JavaScript `number`. This is not a style preference in this doc - it is a signing requirement, and G1-G5 show the exact bytes that go wrong.

Scope split: field-level market/enum/order-object detail lives in `01-coindcx-spot-rest.md`. Key custody and encryption live in `07-api-key-security.md`. This doc owns the transport contract and the legal contract, and does not repeat 01's 35 gotchas.

## Verdict

- Signing is small enough to get exactly right and small enough to get subtly wrong: HMAC-SHA256 hex over **the exact bytes of the body you send**, two headers, and nothing else - no method, no path, no query, no nonce. Serialise once, sign that string, send that string. Golden vectors in D2 make this a unit test.
- `timestamp` inside the signed body is the only thing binding a request to a moment. There is no nonce. `client_order_id` is therefore our only idempotency primitive; treat it as mandatory although CoinDCX marks it optional, and derive it deterministically so a retry regenerates the same value.
- Four published rate-limit figures contradict each other (2000/60s per endpoint; 16/s + 960/min; 100/min; and an undocumented live header saying 5000/60s). Seed the limiter at the tightest published number, then run it closed-loop off the `ratelimit` response headers. Do not trust any single figure.
- One unanswered question governs the whole fan-out architecture: **is the quota keyed on API key or on source IP?** If IP, a 100-account group trade from one egress address is the product's ceiling and we need an egress pool or the HFT tier. This is E1 and it must be settled before Phase 01 freezes.
- The API Licence Terms are adverse to what Tradex is. Non-sublicensable licence; redistribution of market data to third parties prohibited; CoinDCX's total liability capped at INR 1,00,000; unlimited indemnity flowing the other way; termination without notice and without reason; 5-year record retention obligation on us. Anand should read F11 verbatim and decide on the broker/HFT route (`api@coindcx.com`) rather than quietly operating on retail keys.
- Retry safety is decidable from the HTTP status for every case except **500, 503 and network timeout on an order-placing call**. Those three are the only genuinely ambiguous outcomes, and they are precisely where duplicate orders come from. Resolve by lookup on `client_order_id`, never by blind resend.

## Decisions

| Decision | Choice | Why | Rejected alternative |
| --- | --- | --- | --- |
| Body serialisation | One `canonicalBody(obj) -> string` function; sign and send that same string; HTTP client receives a `string`, never an object | The signature covers raw bytes; any re-serialisation by a library is a latent 401 that appears only under load | Passing an object to `fetch`/`axios` and letting it stringify |
| Number formatting | Every numeric field emitted as a JSON **string** built by a decimal library | JS `JSON.stringify` emits `1e-7`, `1e+21`, drops trailing zeros and corrupts integers above 2^53 (G1-G5, verified) | Sending JSON numbers because the docs' samples do |
| Clock | Our own NTP-disciplined monotonic offset; refuse to sign if the last sync is older than 60s | The staleness window is undocumented and the failure symptom is indistinguishable from a bad key (F4) | Trusting the host clock; a `/time` endpoint (none exists) |
| Idempotency | `client_order_id` on every create, derived deterministically from (intent id, account id) | Only mechanism CoinDCX offers; reuse is documented as rejected, which is the behaviour we want | Relying on `timestamp` uniqueness |
| Rate limiting | Central token bucket keyed on **both** api-key and egress IP, seeded 100/60s, widened only by measurement, driven by `ratelimit` headers when present | The four published figures disagree by 50x; only the headers are asserted by the server | Hard-coding 2000/60s from the per-endpoint table |
| 429 backoff | Exponential with full jitter; treat 429 on create as **indeterminate**, not failed | No `Retry-After` header is sent (verified absent) | Immediate retry |
| Error classification | Branch on numeric `code`; `errorCode` optional; `message` never load-bearing except via a versioned substring table | Envelope is not uniform across routes (F9.2) | Matching on `message` strings |
| Audit | Persist `x-request-id` with every request/response pair | Present on every response; the only handle CoinDCX support can act on | Logging our own id only |
| Legal posture | Ask CoinDCX in writing whether a multi-account SaaS on customer keys is permitted; pursue broker enrolment | Clause 2.1 is non-sublicensable and 2.3(c) bans redistribution of Market Data (F11) | Assuming silence is permission |
| Batch endpoints | Do **not** use `orders/create_multiple` for group fan-out | Single-account, INR-only, max 10 (F7). Fan-out is N single creates | Treating it as a group primitive |

## Findings

### F1. Provenance of this ground truth

| Item | Value | Tag |
| --- | --- | --- |
| Local source | `research/_sources/coindcx-docs.txt`, 14,111 lines | VERIFIED |
| Matches live | Re-fetched `https://docs.coindcx.com/` on 2026-09-03: 1,119,537 bytes, byte-identical to the saved HTML except a per-request Cloudflare Rocket-Loader nonce at byte 4850 | VERIFIED |
| Version marker | None. No revision number, no date, no changelog anywhere in the page | VERIFIED (by absence) |
| Second, conflicting source | `https://coindcx.com/api/help/*` - 403 to WebFetch, 200 to curl with a browser UA. Contradicts the docs on rate limits | VERIFIED |
| Live probes | 14 unauthenticated requests to `api.coindcx.com` on 2026-09-03. No API key used, no order placed, no money moved | VERIFIED |
| Node facts | Reproduced locally on Node v24.15.0 | VERIFIED |

Because the docs carry no version marker, a silent breaking change is undetectable. Hash the HTML weekly in CI and diff.

### F2. Hosts, transports and the observed edge

| Host | Serves | Auth | Tag |
| --- | --- | --- | --- |
| `https://api.coindcx.com` | all authenticated spot/margin/futures endpoints, plus most public ones (63 occurrences) | HMAC headers | VERIFIED docs 543 |
| `https://public.coindcx.com` | a few market-data routes only, *"it will only be used where it is exclusively mentioned"* | none | VERIFIED docs 543 |
| `https://hft-api.coindcx.com` | HFT tier: *"faster API response and higher rate-limits"*, enterprise-only, requires a static IP registered as a Trusted IP | HMAC headers (assumed) | VERIFIED on the help site; **absent from docs.coindcx.com entirely** |
| `wss://stream-spot.coindcx.com` | spot Socket.IO (one sample writes it `https://`) | per-channel HMAC | VERIFIED docs 6236, 6321 |
| `wss://stream.coindcx.com` | futures Socket.IO - a different host | per-channel HMAC | VERIFIED docs 13371 |

Edge stack observed on every live response (VERIFIED): Cloudflare -> `via: kong/3.4.2` -> Envoy (`x-envoy-upstream-service-time`), Mumbai edge (`CF-RAY: ...-BOM`). Cloudflare Bot Management is active - responses set `__cf_bm` and `_cfuvid`. Consequence: a challenge can return **HTML, not JSON**. The client must check `content-type` before parsing and classify a non-JSON body as indeterminate, not as a failure.

Docs typo (VERIFIED, docs ~9380): one futures cancel URL is written `https://api.coindcx.com//exchange/v1/...` with a doubled slash.

### F3. The signing scheme, byte for byte

Verbatim, docs lines 1280-1282:

> Common Notes:- All the Authenticated API calls use POST method.
> - Parameters are to be passed as JSON in the request body.
> - Every request must contain a timestamp parameter of when the request was generated. This timestamp is used to validate that the request is not a very old one (due to some lag in any layer) - the request is rejected with an appropriate error if this timestamp deviates too much from the server's time at which it is received to be processed.

Verbatim, docs lines 1381-1387:

> - The payload is the parameters object, JSON encoded
> `payload = parameters-object -> JSON encode`
> - The signature is the hex digest of an HMAC-SHA256 hash where the message is your payload, and the secret key is your API secret.
> `signature = HMAC-SHA256(payload, api-secret).digest('hex')`

Request contract:

| Element | Value | Required | Tag |
| --- | --- | --- | --- |
| Method | `POST` for every authenticated call | yes | VERIFIED docs 1280; **GET returns 404, not 405** (F9.2) |
| `Content-Type` | `application/json` | see G7 | VERIFIED docs 1322 (all Python samples) |
| `X-AUTH-APIKEY` | the API key, plaintext, no prefix | yes | VERIFIED docs 1394 |
| `X-AUTH-SIGNATURE` | lowercase hex HMAC-SHA256, 64 chars | yes | VERIFIED docs 1398 |
| Body | the parameters object, compact JSON | yes | VERIFIED docs 1381 |
| `timestamp` (in body) | epoch **milliseconds**, integer | yes | VERIFIED by every code sample; contradicted by prose (F4) |

What is covered by the signature, and what is not:

| Covered | Not covered |
| --- | --- |
| The exact bytes of the request body | HTTP method |
| | Request path - the same body signs identically for `users/balances` and `orders/create` |
| | Query string (authenticated calls use none) |
| | Any header, including `X-AUTH-APIKEY` |
| | A nonce - there is none |
| | A body hash or length - the body *is* the message |

Two consequences that matter for a money system:

- The scheme is a **body MAC, not a request MAC**. An attacker who captures a signed body can replay it against any other endpoint that accepts the same shape, within the (undocumented) staleness window. We cannot fix this - it is CoinDCX's scheme - but we must not add to the exposure: never log a signed body next to its signature.
- Because the path is unsigned, a bug that posts an order body to the wrong URL fails with 404, not 401. Route selection has no cryptographic protection; it must be covered by tests.

### F4. The timestamp: milliseconds, in spite of four places saying seconds

| Where | What it says | Tag |
| --- | --- | --- |
| Auth Common Notes, docs 1282 | a `timestamp` "of when the request was generated", rejected if it "deviates too much" - **no number given** | VERIFIED |
| Every Python sample | `int(round(time.time() * 1000))` -> milliseconds | VERIFIED docs 1305, 1424, 1685 |
| Every JavaScript sample | `Math.floor(Date.now())` -> milliseconds | VERIFIED docs 1338, 1631 |
| Sub-account transfer param table, docs 1749 | *"EPOCH timestamp in seconds"* | VERIFIED - and contradicted by the ms code in the same block |
| Wallet transfer param table, docs 1955 | *"EPOCH timestamp in seconds"* | VERIFIED |
| Futures create-order sample, docs 8856 | `timestamp: timeStamp, // EPOCH timestamp in seconds` above ms code | VERIFIED |
| Every spot parameter table example value | `1524211224` - ten digits, i.e. seconds (2018-04-20) | VERIFIED docs 2215, 2673, 3018 |

Ruling: **send milliseconds.** Every executable sample does. The seconds claims appear only in prose and example columns.

Two things remain UNVERIFIED and both are load-bearing:

- **Window size.** Not stated anywhere. Experiment E2: on `POST /exchange/v1/users/balances` with a real key, send `timestamp` at now, now-10s, now-30s, now-60s, now-300s, now+30s, now+300s, and record the first rejection in each direction. Record the exact status and body.
- **Skew symptom.** The docs say only "an appropriate error". If it is `401 Invalid credentials` - the same body a wrong key produces - then a customer whose *our-side* clock drifted would be told their key is invalid. E2 must capture the body, not just the code. If the two are indistinguishable we must never surface "invalid key" to a customer without first asserting our own clock health.

### F5. Credential lifecycle, scope and the PII that comes with a key

| Fact | Verbatim / detail | Tag |
| --- | --- | --- |
| Multiple keys per user | *"Yes, there are no restriction on creating Key and Secret."* | VERIFIED docs 13910 |
| No read-only keys | Q: *"Are there Read Only APIs available for CoinDCX Public APIs"* A: *"No, we currently don't have Read Only APIs."* | VERIFIED docs 13912 |
| No scoping at all | *"Since all API users have the same level of permissions, API keys are interchangeable."* | VERIFIED docs 13920 |
| Secret shown once | *"The Secret key is forever hidden after you refresh the screen."* | VERIFIED help site |
| Delete is final | Q: *"Can the same API Key be regenerated once it gets deleted"* A: *"No, you'll need to generate a new API key and secret for security purposes."* Help site: *"A key, once deleted, cannot be used for any further authentications for the API."* | VERIFIED docs 13915, help site |
| IP binding is per-device | *"Checking the Binding IP address to the API Key option will bind the API key to the IP of the device from which the key is generated."* | VERIFIED help site |
| IP binding blocks sharing | *"If the Key is binded with the IP, then these API can only be used with the binded IP and cannot be shared with ony other user having different IP."* | VERIFIED docs 671 |
| Creation needs email + SMS OTP | Two-factor at key-creation time | VERIFIED docs 667 |
| Sub-account transfer needs a recent key | *"this endpoint would only be available to users who have created an API key post 12th August, 2024"* | VERIFIED docs 1731 |
| Eligibility | *"Currently to use CoinDCX's API stack, you have to be either an Indian citizen or an Indian entity as per the current regulations."* | VERIFIED info.coindcx.com |

A key is not just trading authority - it is a PII grant. `POST /exchange/v1/users/info` returns `coindcx_id`, `first_name`, `last_name`, `mobile_number`, `email` (VERIFIED docs 1597-1604). That pulls Tradex directly under Licence clause 8 (F11), which obliges us to protect PII received through the API and to report unauthorised access. Design implication: Tradex should never call `users/info` unless a feature needs it, and if it does, the response must be treated as regulated PII, not as diagnostics.

Contact addresses, de-obfuscated from the Cloudflare email protection in the source HTML (VERIFIED):

| Address | Role | Source |
| --- | --- | --- |
| `legal@coindcx.com` | where clause 8 requires security deficiencies and intrusions to be reported | docs clause 8 |
| `info@engage-coindcx.com` | sender of scheduled-downtime notices - must be allow-listed in our ops mailbox | docs FAQ |
| `api@coindcx.com` | broker enrolment, market-making and HFT access requests | info.coindcx.com |

### F6. Rate limits - four published figures, none of them agreeing

#### F6.1 The four claims

| # | Source | Claim | Tag |
| --- | --- | --- | --- |
| 1 | docs "SPOT API Rate Limits" table, lines 715-765 | per-endpoint, e.g. Create Order **2000 / 60s**, Cancel All **30 / 60s** | VERIFIED |
| 2 | docs FAQ, line 13925 | *"16/sec, 960/min"* | VERIFIED |
| 3 | `coindcx.com/api/help/Error Codes and Resolution/` | *"CoinDCX API has a 100 requests per minute. If you are sending more requests than that in a minute, this error will occur."* | VERIFIED |
| 4 | live `ratelimit` headers on `api.coindcx.com` | `ratelimit-policy: 5000;w=60` | VERIFIED by probe |

The spread is 50x (100/min vs 5000/min). Claim 2 is internally consistent (16 x 60 = 960). Claim 1 cannot be a global budget because 2000/60s exceeds claims 2 and 3. The most defensible reading:

- Claim 1 is a **per-route ceiling**, not an allowance you can actually spend.
- Claim 2 or 3 is the **global per-principal budget**; which one is current is unknown, and the help site (100/min) is the tightest and possibly the most recent.
- Claim 4 is a **gateway/route bucket** enforced by Kong, visible only where the request reaches the limiter.

Engineering rule: seed the limiter at **100 requests / 60s per principal**, drive it closed-loop from the headers, and widen only against measurement (E1). Never widen against a doc.

#### F6.2 The undocumented headers the server actually sends

Probed 2026-09-03, unauthenticated GETs (VERIFIED):

| Route | HTTP | `ratelimit-policy` | `ratelimit` | `cf-cache-status` |
| --- | --- | --- | --- | --- |
| `GET /exchange/ticker` | 200 | `5000;w=60` | `limit=5000, remaining=4992, reset=8` | `HIT` |
| `GET /exchange/v1/markets` | 200 | `5000;w=60` | `limit=5000, remaining=4999, reset=60` | `DYNAMIC` |
| `GET /market_data/orderbook?pair=B-BTC_USDT` | 200 | `5000;w=60` | `limit=5000, remaining=4999, reset=60` | `DYNAMIC` |
| `POST /exchange/v1/users/balances` (401) | 401 | **absent** | **absent** | `DYNAMIC` |

Readings:

- These are IETF-draft lowercase `ratelimit` / `ratelimit-policy` headers, **not** `X-RateLimit-*`. Nothing in the docs mentions them. A client that greps for `X-RateLimit` will find nothing and conclude there is no feedback.
- Two different routes each reported `remaining=4999` on their first call in a fresh window, so the bucket looks **per-route**, not global.
- `reset` is **seconds remaining in the window**, not a Unix timestamp.
- On a cache `HIT` the counters belong to whoever missed last - do not meter off a cached response. Check `cf-cache-status` before trusting `remaining`.
- The authenticated 401 carried no headers. Either the limiter sits behind auth, or 401 short-circuits before it. **UNVERIFIED for authenticated 200s** - this is the single highest-value unknown in this doc, because if authenticated routes do emit them the limiter becomes closed-loop instead of guesswork. Experiment E3: one successful `users/balances` call with a real key, dump all response headers.
- `Retry-After` is never sent (VERIFIED absent from docs and from all 14 live responses). All backoff timing is ours to invent.

#### F6.3 The per-endpoint table, verbatim (docs 715-765)

| API Name | Rate Limit | Period |
| --- | --- | --- |
| Create Order Multiple | 2000 | 60s |
| Create Order | 2000 | 60s |
| Cancel All | 30 | 60s |
| Multiple Order Status | 2000 | 60s |
| Order Status | 2000 | 60s |
| Cancel Multiple by ID | 300 | 60s |
| Cancel | 2000 | 60s |
| Active Order | 300 | 60s |
| Edit Price | 2000 | 60s |

Nine rows, and that is the whole table. Not listed anywhere: `users/balances`, `users/info`, `orders/trade_history`, `orders/active_orders_count`, `wallets/*`, every public endpoint, every margin endpoint, every futures endpoint, and every socket. The table is titled **SPOT** API Rate Limits; there is no futures equivalent.

Three of these bind us hard:

- **Cancel All at 30/60s** is 66x tighter than Create. A panic "flatten every account in the group" that maps to one `cancel_all` per account exhausts the budget at 30 accounts per minute. A 100-account group cannot be flattened via `cancel_all` inside a minute. Design consequence in D4.
- **Active Order at 300/60s** caps our polling. With `active_orders` requiring a `market` parameter (see 01), reconciling 100 accounts across 3 markets is 300 calls - the entire minute's budget for one sweep.
- **Cancel Multiple by ID at 300/60s** with a max of 10 ids per call gives 3,000 cancels/minute in principle, but only within one account per call.

#### F6.4 The HFT escape hatch

Verbatim from `coindcx.com/api/help/High Frequency Trading/` (VERIFIED):

> CoinDCX API provides a speacialized access to our High Frequency APIs for enterprise clients. These APIs allow our clients to trade and receive data with faster API response and higher rate-limits.
> The base URL for all the HFT URLs will be, `https://hft-api.coindcx.com`
> Our team members will request you for a static IP address which we will keep as our Trusted IPs for HFT. Once your IP address has been added as 'Trusted', you will receive the required access to our HFT API services.

This is the documented answer to a rate-limit ceiling, and it is a business conversation, not an engineering one. It also has an architectural consequence we should want anyway: a **static egress IP**. Note that clause 6.4 of the Licence (F11) requires the User to hold *"the relevant licenses to conduct any High Frequency Trading or Algorithmic Trading"* - which is a question for Anand's counsel before we ask for the tier.

### F7. Every other documented cap

| Cap | Value | Endpoint / scope | Tag |
| --- | --- | --- | --- |
| Open orders per market | **25** at a time | spot, one market, one account | VERIFIED docs 2177 |
| Open orders per market (margin) | **10** at a time | margin | VERIFIED docs 4534 |
| Orders per batch create | **10**, INR markets only, `ecode: "I"` | `orders/create_multiple` | VERIFIED docs 2479 |
| Order ids per status batch | **10** | `orders/status_multiple` | VERIFIED docs 2826 |
| Order ids per cancel batch | **10** | `orders/cancel_by_ids` | VERIFIED docs 3588 |
| `client_order_id` length | **36 characters** max | any create | VERIFIED docs 14015 |
| Public trades page | default 30, max **500** | `market_data/trade_history` | VERIFIED docs 1081 |
| Candles page | default 500, max **1000** | `market_data/candles` | VERIFIED docs 1261 |
| Active orders page | default 200, max **200** | `orders/active_orders` | VERIFIED docs 2986-2988 |
| Trade history page | default 500, max **500** (`limit`) | `orders/trade_history` | VERIFIED docs 3176 |
| Generic page | default 100, max **1000** (`size`) | Pagination section | VERIFIED docs 6206 |
| Margin fetch page | default **10** (`size`), no max stated | `margin/fetch_orders` | VERIFIED docs 5955 |
| Socket orderbook depth | up to **50** recent orders, snapshot only, not configurable | sockets | VERIFIED docs 14031-14039 |
| Max trade size | not a global number - read `max_quantity` per market from Market Details | see 01 | VERIFIED docs 13938 |

The 25-open-orders-per-market cap is a group-trade hazard: a group of 30 accounts is fine (the cap is per account), but a strategy that leaves resting limit orders and re-places them will hit 25 inside one account long before anything else breaks. Track it per (account, market) in our own state and refuse the 26th before sending.

### F8. Pagination - one documented scheme, four actual idioms

The Pagination section (docs 6147-6229) documents exactly two parameters and one response header.

Request parameters, verbatim (docs 6196-6208):

| Name | Description |
| --- | --- |
| `page` | Page number to fetch. Pagination starts at page 1 |
| `size` | Number of records per page; Default: 100, Max: 1000 |

Response: the pagination metadata is **not in the body**. It is a JSON string in the `x-pagination` response header (VERIFIED docs 6217):

```
x-pagination: {"total":29,"total_pages":6,"first_page":false,"last_page":false,"previous_page":1,"next_page":3,"out_of_bounds":false,"offset":5}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `total` | number | total records matching the query |
| `total_pages` | number | pages at the requested `size` |
| `first_page` / `last_page` | boolean | position flags |
| `previous_page` / `next_page` | number, or null (assumed) | adjacent page numbers; `null` at the edges is UNVERIFIED |
| `out_of_bounds` | boolean | true when `page` exceeds `total_pages` |
| `offset` | number | records skipped |

Now the problem. Four different paging idioms exist across the API, with four different defaults:

| Endpoint | Params | Default | Max | Metadata | Tag |
| --- | --- | --- | --- | --- | --- |
| Pagination section / `margin/fetch_orders` | `page`, `size` | 100 | 1000 | `x-pagination` header | VERIFIED docs 6206 |
| `margin/fetch_orders` param table | `size` | **10** | not stated | " | VERIFIED docs 5955 |
| `orders/active_orders` | `page`, `size` | **200** | **200** | UNVERIFIED whether the header is sent | VERIFIED docs 2986 |
| `orders/trade_history` | `limit`, `from_id`, `sort`, `from_timestamp`, `to_timestamp` | **500** | **500** | none - cursor style | VERIFIED docs 3170-3212 |
| public `market_data/trade_history` | `limit` | 30 | 500 | none | VERIFIED docs 1081 |
| public `market_data/candles` | `limit`, `startTime`, `endTime` | 500 | 1000 | none | VERIFIED docs 1250-1261 |

Notes an implementer needs:

- The same endpoint (`margin/fetch_orders`) is documented with two different `size` defaults in two places, 250 lines apart. The generic section says 100; its own parameter table says 10.
- `orders/trade_history` is **cursor-paged on `from_id`**, not page-paged, and its parameter is `limit`, not `size`. It is the only account-history endpoint we get for spot, so our backfill must be a cursor loop, not a page loop.
- `x-pagination` is a header, so any HTTP client wrapper that discards response headers silently destroys the ability to page. Parse defensively: the header is JSON-in-a-header and could be truncated by an intermediary.
- Whether `x-pagination` appears on `orders/active_orders` and `orders/trade_history` is UNVERIFIED. Experiment E4: page 2 of each with a real key, dump headers.
- `page` is 1-based (*"Pagination starts at page 1"*). A 0 is UNVERIFIED - it may be treated as 1, as out-of-bounds, or as an error.

### F9. Errors

#### F9.1 The documented HTTP status table, verbatim (docs 14077-14111)

| Error Code | Meaning |
| --- | --- |
| 400 | Bad Request -- Your request is invalid. |
| 401 | Unauthorized -- Your API key is wrong. |
| 404 | Not Found -- The specified link could not be found. |
| 429 | Too Many Requests -- You're making too many API calls |
| 500 | Internal Server Error -- We had a problem with our server. Try again later. |
| 503 | Service Unavailable -- We're temporarily offline for maintenance. Please try again later. |

That is the entire documented list. **422 is missing from it** and is returned in practice (F9.4, and 01's live probes). The FAQ adds (VERIFIED docs 13929-13936):

> In the case of API failure you get a 5xx error. The 2 applicable errors are:
> - 500: Internal Server Error. This is a one-off error that happens due to internal issues on CoinDCX's side
> - 503: Service Unavailable. This error is thrown when there is a downtime at CoinDCX. These should get resolved fairly quickly.
> For scheduled downtimes, you would receive prior notification over e-mail from the email ID [email protected] among other CoinDCX email IDs. Please add us to your address-book so as to not miss such important emails.

(That obfuscated address decodes to `info@engage-coindcx.com`.)

#### F9.2 The actual error envelope, from live probes (VERIFIED 2026-09-03)

| Probe | HTTP | Body |
| --- | --- | --- |
| `POST users/balances`, fake key + fake signature | 401 | `{"code":401,"message":"Invalid credentials","status":"error"}` |
| `POST users/balances`, no auth headers at all | 401 | `{"code":401,"message":"Invalid credentials","status":"error"}` |
| `POST orders/create`, fake key + fake signature | 401 | `{"code":401,"message":"Invalid credentials","status":"error","errorCode":"BFF-AUTH-001"}` |
| `POST users/balances`, malformed JSON body | 400 | `{"status":"error","message":"bad_request","code":400}` |
| `GET users/balances` (wrong method) | **404** | `{"status":"error","message":"not_found","code":404}` |
| `POST users/balances_nope` (bad path) | 404 | `{"status":"error","message":"not_found","code":404}` |

What this establishes:

- The envelope is `{status:"error", code:<number>, message:<string>}` and `code` mirrors the HTTP status. Branch on `code`.
- `errorCode` is an **undocumented, optional** machine-readable namespace. `BFF-AUTH-001` on `orders/create`; `BFF-SO-004` on public market-data validation (see 01). It is absent on `users/balances` and on the 400/404 envelopes. So the same logical failure (bad credentials) yields two different bodies depending on which internal service fronts the route. Treat `errorCode` as a bonus, never a requirement.
- **A wrong HTTP method returns 404, not 405.** This is the single most misleading response in the API: an implementer who follows the docs' own Python `requests.get(...)` samples for the futures wallet endpoints will get `not_found` and conclude the endpoint does not exist. Always POST.
- Malformed JSON is rejected **before** credentials are checked (400 with fake creds present). So a 400 `bad_request` never implies anything about the key.
- `x-request-id` (a UUID) is present on essentially every response and is the only handle CoinDCX support can act on. Persist it with both the request and the response. It was absent from one probe's headers (the `orders/create` 401), so treat it as optional but log it whenever present.
- `x-runtime`, `x-kong-upstream-latency`, `x-kong-proxy-latency` and `x-envoy-upstream-service-time` are present and give free server-side latency attribution - worth capturing for the health dashboard.

#### F9.3 Retry-safety classification

The property we need is the brief's "no duplicate order". That reduces to: for each outcome, do we know whether the exchange accepted the intent?

| Outcome | Accepted? | Retry safe? | Action |
| --- | --- | --- | --- |
| 200 with an order object | Yes | n/a | Record `id`; done |
| 400 `bad_request` (malformed JSON) | No - rejected before auth | Yes, after fixing the body | Bug in us. Alarm, do not retry blind |
| 400 with a validation message | No | Only after correcting the input | Refuse the intent; surface to the user |
| 401 | No | Yes once the cause is fixed | Distinguish key vs clock via our own clock health (F4) |
| 404 | No - never reached a handler | Yes, to the correct URL | Bug in us: wrong path or wrong method |
| 422 | No | Only after correcting the input | Undocumented status; treat as a validation refusal |
| 429 | **Unknown** | **No** | Indeterminate. Back off, then resolve by lookup on `client_order_id` |
| 500 | **Unknown** | **No** | Indeterminate. Resolve by lookup |
| 503 | **Unknown**, but likely not | **No** | Indeterminate. Resolve by lookup |
| Network timeout / connection reset | **Unknown** | **No** | Indeterminate. Resolve by lookup |
| Non-JSON body (Cloudflare challenge / HTML) | **Unknown** | **No** | Indeterminate. Resolve by lookup |

Only the four indeterminate rows matter for correctness, and they all have the same remedy: **never resend a create; look it up.** Because `client_order_id` reuse is documented as rejected (docs 2245: *"Must be unique per order for each user. Reusing an existing client_order_id will be rejected"*), a resend with the same id is *probably* safe-by-rejection - but "probably" is not a property we can ship, and the rejection wire format is UNVERIFIED. Experiment E5: place a tiny limit order far from the market with `client_order_id = X`, then place the identical body again, and record the exact status, `code`, `message` and `errorCode`. If the duplicate rejection is distinguishable from every other 4xx, resend-with-same-id becomes a legitimate second line of defence behind lookup.

429 deserves its own note: the docs list it, `Retry-After` is never sent, and a 429 on a create tells us nothing about whether the order was placed before the limiter fired. We must assume it may have been.

#### F9.4 The per-endpoint error tables that do exist

There is **no error table for any `orders/*` endpoint**. Three tables exist elsewhere, and they are the only evidence we have of CoinDCX's error vocabulary and status conventions. Reproduced because they set the pattern the spot order routes probably follow (that inference is UNVERIFIED).

`wallets/sub_account_transfer`, verbatim (docs 1778-1828):

| Status | Message | Reason |
| --- | --- | --- |
| 422 | Invalid transfer | invalid from_account_id or to_account_id passed |
| 401 | Unauthorized access | Transfer initiated by sub account user |
| 400 | Currency short name not present | Invalid currency_short_name provided |
| 404 | source wallet not found | Source currency wallet is not created for user |
| 404 | destination wallet not found | Destination currency wallet is not created for user |
| 422 | Unverified Sub-Account | Email verification pending for sub account user |
| 400 | Insufficient funds | Amount to be transferred is more than the available wallet balance |
| 422 | Amount should be greater than | Amount should be greater than |
| 422 | Your withdrawals are blocked for another XX hours because you changed your account authentication mode | User is under surveillance |

`wallets/transfer`, verbatim (docs 1982-2016):

| Status | Message | Reason |
| --- | --- | --- |
| 422 | Invalid amount | Amount to be transferred should be positive |
| 422 | Invalid currency | Invalid currency_short_name provided |
| 422 | Derivatives Futures Wallet creation is not allowed for currency_short_name: `<currency_short_name>` | Futures wallet creation not allowed for currency |
| 422 | This feature is not enabled yet. | Futures wallet not enabled for user |
| 404 | Wallet not found | Futures wallet not created for user |
| 400 | Insufficient funds | Amount to be transferred is more than the available wallet balance |

Futures `orders/create`, the money-sizing rows verbatim (docs 9121-9210) - the closest thing we have to a spot order-rejection vocabulary:

| Status | Message | Reason |
| --- | --- | --- |
| 400 | Insufficient funds | Wallet doesn't have sufficient funds for placing the order |
| 400 | Minimum order value should be x USDT | Order value must be greater than min notional |
| 400 | Price should be divisible by 0.01 | Price isn't divisible by the tick size |
| 400 | Please enter a value lower than x | Price is greater than max limit price (ltp + ltp * multiplier_up) |
| 400 | Please enter a value higher than x | Price is lower than min limit price (ltp - ltp * multiplier_down) |
| 400 | Price is out of permissible range | limit or stop price outside max_price / min_price |
| 422 | Quantity should be greater than y | Quantity isn't greater than min quantity |
| 422 | Quantity for limit variant orders should be less than 9500.0 | exceeds max limit-order quantity |
| 422 | Quantity for market variant orders should be less than 9500.0 | exceeds max market-order quantity |
| 422 | Price can't be empty for limit_order Order | - |
| 500 | *(blank message)* | Invalid input |

Three patterns to carry into the adapter:

- **Sizing rejections split across 400 and 422 with no rule**: notional and tick violations are 400, quantity violations are 422. Do not treat 422 as "our bug" and 400 as "their bug" - both are validation refusals.
- **"Insufficient funds" is 400, not 402 or 422.** In a group trade this is the most likely per-account partial failure, and it arrives as a generic 400. Substring matching is unavoidable here; version the table.
- **A 500 can carry the reason "Invalid input"** - i.e. a deterministic client error surfaced as a server error. That row alone forbids "retry all 500s".

#### F9.5 The FAQ error strings, verbatim (docs 14053-14074)

| String | Documented cause |
| --- | --- |
| "Invalid Request" | *"something incorrect in the request body"*: missing mandatory params, wrong values in query params, *"Not using the right JSON structure in the request body"* |
| "Order type not allowed" | *"This happens when particular order type is not allowed for the market For example: BTCINR market has only limit and market type orders, so user won't be able to place stop_limit orders for BTCINR market."* |
| "Too Many Requests" | *"user makes too many API calls which leads to rate limit for a user"* |
| "This order cannot be cancelled" | *"the order id passed in the request body is in filled, cancelled or rejected status. Order can be cancelled only when its in open or partially_filled status"* |
| "packet queue is empty, aborting" | socket only: *"connection with the socket is lost... please connect with the socket again and re-join the channel"* |

Note "Too Many Requests" is *"for a user"* - the only textual hint anywhere that the quota is per-user rather than per-IP. It is a FAQ paraphrase, not a specification, so it does not settle E1.

Also verbatim, the two lists of order-failure causes (docs 14017-14026):

> What are the various reasons for which orders could not be placed
> - There isn't enough balance present in the user's wallet
> - Rate limits have been hit
> - The order type sent is not present for the market
> - The mandatory fields needed to execute the order are not sent

> What are the various reasons for which orders could be rejected after getting placed
> There could be several edge cases because of which an order could be placed but rejected at a later stage. One of them is that in case of market orders, the order value could go below the min notional value of the market.

The second one is the important one and it is easy to miss: **acceptance is not terminal.** A 200 from `orders/create` can still become `rejected` afterwards. Our state machine must therefore treat "accepted" as non-terminal and must reconcile, exactly as the brief's "no silent divergence" property requires.

### F10. The rest of the FAQ, distilled to what changes our design

| FAQ item | Verbatim / substance | Design consequence |
| --- | --- | --- |
| Multiple keys | *"there are no restriction on creating Key and Secret"* | A customer can give each Tradex account its own key. Encourage it. |
| No read-only keys | *"we currently don't have Read Only APIs"* | We cannot offer a view-only mode backed by a scoped key. See 07. |
| Key sharing | *"Since all API users have the same level of permissions, API keys are interchangeable. However in case you choose to bind API keys with IP addresses, you might need to create a different API key for every user."* | The closest CoinDCX comes to blessing third-party key handling. It contemplates keys used by someone other than the creator, and its only stated caveat is IP binding. Not an authorisation; see F11. |
| Max trade size | *"can be found from the max_quantity key from Market Details API... depends on the Exchange that you are trading on"* | Per-market, per-venue. Cache market details; refuse before sending. See 01. |
| Trade history | *"API keys are different for master and sub account and so are the trade history APIs"* | Sub-accounts are separate principals end to end. A Tradex "account" maps 1:1 to a key, never to a person. |
| Sub-accounts | *"API keys are different for master and sub accounts and so are the trades and trade histories"* | Same. |
| Futures via API | Q: *"Is Futures trading available through Public APIs"* A: *"No, currently this feature is not available."* | Directly contradicted by ~5,500 lines of futures endpoints in the same document. The FAQ is stale. Do not use it as an availability oracle. |
| min quantity derivation | *"the maximum of the above 2 values"* - `max(min_quantity, 10^-target_currency_precision)` | The legality check in 01/05 must use the max, not `min_quantity` alone. |
| fee vs fee_amount | *"fee returns the fee percentage... fee_amount parameter returns the absolute amount of fee charged in the base currency"* | P&L must not double-count. `fee_amount` is in **base** currency (i.e. the quote/price asset under CoinDCX's inverted naming - see 01 F0). |
| Failed transactions | *"No fee would be applicable on a failed transaction"* | A rejected order contributes nothing to cost basis. |
| Fee tier via API | *"We currently don't have this available on our APIs"* | Fee tier cannot be discovered; it must be a per-account setting the customer enters, or inferred from realised `fee` values. |
| Open orders count | *"Using the Order Book Rest API"* or the `depth-update` socket event | This answer is wrong for our purpose - it describes market depth, not the user's open orders. Use `orders/active_orders_count`. |
| Orderbook snapshots | *"On orderbook related data on CoinDCX Websockets are snapshot updates only"*, *"upto 50 recent orders"*, depth not configurable | No incremental book maintenance needed, and no deep book available. Relevant to charting/market-data track. |
| Private channels | *"On private channels, user specific information like New orders, order updates,user balance update are available. These can be accessed post authentication via API key and secret."* (missing space is in the source) | Order updates arrive by socket. That is the cheap path to "no lost order" without burning the 300/60s polling budget. |
| Socket library | *"CoinDCX Websockets are currently implemented via Socket.io. This is the only officially supported library"* | We must ship a Socket.IO client, not a raw WebSocket client. |
| Scheduled downtime | prior notice by email from `info@engage-coindcx.com` | Allow-list it and route it to an ops channel; a 503 window should never be a surprise. |
| Data without auth | public REST endpoints and *"the order book and market data"* on websockets | Chart and market data need no customer key - so the charting surface must never touch a key. |

### F11. The API Licence Terms - verbatim, and what each clause does to Tradex

All 13 clauses read (docs 396-538). These are *"API License Terms and Conditions"* separate from the consumer Terms of Use, and clause 6.5 pulls the Terms of Use in as well. Quoted verbatim below wherever the wording constrains a platform operating on other people's behalf. Everything in this subsection is VERIFIED against docs 396-538.

Who is bound. Clause 1.9:

> "Licensee" shall mean the User and any person accessing any CoinDCX API or any services or products governed by these Terms.

The preamble binds the User on access, and defines User broadly:

> These API License Terms and Conditions ("Terms") shall govern the use of any 'Market Data' and Application Programming Interface (API) of CoinDCX by you, either an individual, association of persons, company, or any legal entity and its respective affiliates (hereinafter referred to as "User").

> The User hereby agrees and acknowledges that upon accessing any CoinDCX API (defined hereinafter), Market Data and/or any other information, service, feature governed by terms contained herein, the User shall be bound by these Terms, as updated, modified, and/or replaced from time to time. The User is required to check for any such amendment, replacement or changes to the terms contained herein and any future use or access to any services covered herein.

So Tradex Pvt Ltd (or Anand) is a Licensee in its own right the moment our servers call the API, independently of the customer whose key we hold. Both of us are bound, and the terms can change without notice to us.

The licence grant. Clause 2.1, 2.2:

> 2.1. User hereby understands and acknowledges that upon agreeing to the terms contained herein, the User is granted a non-exclusive, non-transferable, non-assignable, non-sublicensable, revocable, restricted license for usage purpose only in accordance with the Applicable Law(s).

> 2.2. User hereby agrees that the License granted as per these Terms is only for the authorized use of the CoinDCX API, Market Data and any software provided as per the terms contained herein.

Clause 2.3, all four sub-clauses:

> 2.3. The User shall always ensure that:
> a) The User does not alter, manipulate, or misrepresent any CoinDCX API or Market Data
> b) The User shall not copy, reverse engineer, decompile, disassemble, or attempt to derive the source code, algorithm, structure, of the CoinDCX API or any software provided to the User hereunder.
> c) The User shall not redistribute, display, or disseminate the Market Data or any data, charts, analytics, research, or other works based on, referring to, or derived from the Market Data to any third party.
> d) Any use by the Affiliates of User shall be disclosed to CoinDCX and it may involve additional pricing.

Clause 2.3(c) is the sharpest edge in the whole document for us. Read literally it prohibits displaying market data, charts, or anything derived from market data to any third party - which is a description of requirement 11 of the brief (live charts) and of the analytics in requirement 10 insofar as they are derived from prices. "Market Data" is defined in the preamble as *"all data related to the trading activity"* on CoinDCX platforms including *"the prices and quantities of orders and transactions executed"*.

Fees. Clause 3.1, 3.2:

> 3.1. The User hereby agrees and acknowledges that presently no fees or charges are levied by CoinDCX for the use of CoinDCX API. However, nothing contained in this section, or these Terms shall restrict or limit the right of CoinDCX to charge fees or levy charges for use of the services captured herein including the CoinDCX APIs.

> 3.2. CoinDCX shall have a right to waive any fee/ charges based on the use of the CoinDCX API / Market Data by the User(s). The User hereby understands and acknowledges that rates/ charges/ fees may differ for Users on account of several factors including but not limited to jurisdiction, scale of use, type of entity etc. and the User waives the right to claim against CoinDCX in this regard.

API access is free today, chargeable at CoinDCX's discretion tomorrow, with no notice period specified and the right to complain waived. Any Tradex pricing model must survive an API fee appearing.

Ownership. Clause 4.1:

> 4.1. The User hereby agrees and acknowledges that CoinDCX shall retain the ownership and the Intellectual Property Rights in all the Company Data, CoinDCX API and Market Data including any software or service provided or granted to the User as per the terms contained herein.

Termination. Clauses 5.2 and 5.3:

> 5.2. These Terms may be terminated by CoinDCX without any notice to the User and without assigning any reason. The User understands and agrees that this could affect the User's right to use any of the services or benefits granted by virtue of these Terms. The User hereby waives any and all rights to claim under this section.

> 5.3. Termination for breach:
> User's access to the CoinDCX API or any Market Data shall be terminated/ revoked by CoinDCX forthwith without any notice to the User in the following cases:
> a) Breach of any Intellectual Property Rights of CoinDCX or its Affiliates.
> b) Breach of any terms contained herein.
> c) Use of the CoinDCX API for any fraudulent, illegal, immoral, or any activity not authorized by CoinDCX.

"Activity not authorized by CoinDCX" plus "without any notice" plus a waiver of claims is an existential single point of failure for a business whose only venue is CoinDCX. This is the strongest argument for the adapter boundary in requirement 6 being real from day one rather than aspirational.

User warranties. Clause 6, the sub-clauses that bind us operationally:

> 6.1. The User has the requisite power, authority, consents, licenses, and authorizations to comply with the Terms.

> 6.3. The User shall comply with the Applicable Law(s)

> 6.4. It has the relevant licenses to conduct any High Frequency Trading or Algorithmic Trading and shall ensure that relevant licenses/ approvals/ consents are obtained if the same is required under any Applicable Law(s).

> 6.5. The User represents and warrants that it shall comply with the Terms of Use.

> 6.6. The User hereby represents and warrants that it shall preserve and maintain the information, data and relevant records pertaining to the use of the CoinDCX API/ Market Data for a period of 5 years post termination or expiry of these Terms.

> 6.7. The User understands and agrees that Company is not acting as an advisor or fiduciary with respect to Licensee and is not providing investment advice, tax advice, legal advice, or other professional advice by allowing Licensee to use the Company API and Company Data. Licensee shall be solely responsible, and Company shall have no responsibility, for any decisions of Licensee or its use of the Company API or Company Data and for Licensee's compliance with applicable laws and regulations. Without limiting the foregoing, the Company makes no recommendation regarding the purchase or sale of digital assets or any other asset, or any other investment decision or action, taken by Licensee.

Clause 1.4 defines Algorithmic Trading broadly enough to cover Tradex outright:

> 1.4. "Algorithmic Trading" (also called automated trading, black-box trading, or algo-trading) means a method which uses a computer program following a defined set of instructions or algorithm to place a trade.

A group trade that fans out to N accounts is a computer program following defined instructions to place trades. Under 6.4 the User warrants it holds any licences that Applicable Law requires for that. Whether any Indian licence is in fact required is a legal question, not an engineering one - it belongs to Anand and counsel, and it is on the Open Questions list.

Clause 6.6 is a concrete build requirement, not boilerplate: **five years of retention on all API-usage records, running from termination.** Our audit log is therefore not a nice-to-have and cannot be a 90-day rolling window.

Disclaimer. Clause 7, verbatim in full (capitalisation as published):

> THE COINDCX API, MARKET DATA (INCLUDING DATA PACKAGES) AND ANY OTHER SERVICE/ SOFTWARE PROVIDED BY COINDCX TO THE USER IS PROVIDED ON AN "AS IS'' AND "AS AVAILABLE" BASIS WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESS OR IMPLIED. COINDCX DOES NOT WARRANT THAT THE COINDCX API OR ANY SERVICES PROVIDED HEREUNDER WILL BE SAFE, UNINTERRUPTED, ERROR FREE, OR PROTECT AGAINST ANY HACK, CYBER CRIME OR OTHER THREATS. COINDCX DISCLAIMS ALL OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE FITNESS, QUALITY, PERFORMANCE, NON-INFRINGEMENT, PURPOSE OF THE COINDCX API OR MARKET DATA OR ANY SOFTWARE OR SERVICE PROVIDED TO THE USER. ACCESS ANY USE OF ANY COINDCX API OR MARKET DATA IS AT THE SOLE RISK OF THE USER AND COINDCX SHALL NOT BE RESPONSIBLE FOR ANY ACTIONS TAKEN BASED ON ANY SOFTWARE OR SERVICE PROVIDED HEREUNDER.

This clause is the reason requirement 8 cannot be met as written. The venue itself contractually refuses to warrant that its API is *error free* or *uninterrupted*. Any promise Tradex makes to a customer about accuracy is a promise about **our** behaviour on top of an explicitly unwarranted dependency - which is exactly the set of properties the brief goes on to enumerate. Quote this clause in Tradex's own customer terms; it is the honest boundary.

Security. Clause 8, verbatim in full:

> The user shall ensure that the information received through APIs, including personally identifiable information is protected from unauthorized access or use and shall promptly report to CoinDCX of any unauthorized access or use of such information to the extent required by applicable law. The User must ensure secure operation of CoinDCX APIs by employing reasonable security measures. The Users shall report any security deficiencies or intrusions at [email protected].

(The address is Cloudflare-obfuscated in the published HTML; decoded from the page's `data-cfemail` attribute it is `legal@coindcx.com`.)

Three obligations, all of which land on Tradex: protect PII received through the API (see F5 - `users/info` hands us name, mobile and email), operate the API securely, and report intrusions to `legal@coindcx.com`. This clause, not just good practice, is what makes `07-api-key-security.md` a contractual deliverable. It also means our incident-response runbook needs a CoinDCX notification step with that address in it.

Liability. Clause 9, verbatim in full:

> In no event, whether in tort, contract or otherwise, shall CoinDCX or its Affiliates be liable towards the User for any indirect, special, consequential, incidental, punitive, business loss. Under no circumstances or event shall the maximum aggregate liability of CoinDCX towards the User or any of its Affiliates shall exceed INR 1,00,000/- (Rupees One lakh only).

**CoinDCX's total aggregate liability to us is capped at INR 1,00,000.** Aggregate, not per incident. If a CoinDCX defect mis-executes a group trade across 100 accounts holding lakhs each, our recovery from the venue is one lakh in total, forever. Tradex's customer terms must not promise more than Tradex itself can absorb, and Tradex's own indemnity exposure (next clause) is uncapped in the other direction.

Indemnity. Clause 10, verbatim in full:

> The User shall be liable to indemnify, hold harmless and keep CoinDCX and its Affiliates always indemnified for and against any liability, costs, expenses, damages, charges/ fees (including reasonable attorney and legal fees), claims arising or relating to:
> a) Use of the CoinDCX API/ Market Data or any software provided hereunder
> b) Breach of any Confidentiality terms or any Intellectual Property Rights of CoinDCX and its Affiliates.
> c) Any fraudulent use of the CoinDCX API by the User or its Affiliates
> d) Breach of the terms contained herein

Note the asymmetry: clause 9 caps CoinDCX at one lakh; clause 10 is uncapped and covers *"any liability... arising or relating to... Use of the CoinDCX API"*. A customer of Tradex who misuses their own account through our platform generates an indemnity claim path that runs through us.

Dispute resolution. Clauses 11 and 12:

> 11.1 Any dispute, claim, difference or controversy arising out of, relating to or having any connection with the Terms, including any dispute as to its existence, validity, interpretation, performance, breach or termination or the consequences of its nullity and any dispute relating to any non-contractual obligations arising out of or in connection with it shall be referred to and finally resolved by arbitration administered by the Arbitration Tribunal in accordance with the Arbitration & Reconciliation Act, 1996 as amended, updated, re-enacted from time to time.

> 11.2. The Language of arbitration shall be English and Mumbai, India shall be the seat and place of Arbitration.

> Subject to the Arbitration clause above, these Terms shall be governed by the laws of India and the courts at Mumbai, India shall have exclusive jurisdiction.

Miscellaneous. Clause 13, the operative parts:

> 13.1. The User shall not assign any of its obligations, rights under these Terms to any third party. Assignment to Affiliates shall be only after obtaining the prior written consent of CoinDCX.

> 13.2. Force Majeure - CoinDCX shall not be held responsible for any failure, delay, interruption caused by circumstances outside its control, such as network failure, network connection failure, earthquake, flooding, strikes, embargoes, or any act(s) of the government or any regulatory/ statutory authority.

> 13.3. The User agrees to pay all the necessary taxes as may be imposed under the Applicable Laws.

> 13.4. Failure by CoinDCX to exercise or enforce any rights hereunder shall not amount to waiver of those rights.

> 13.5. Each party is an independent contractor and there shall not be any principal-agent relationship between CoinDCX and the User.

Clause 13.5 matters more than it looks: CoinDCX explicitly disclaims any agency relationship. Tradex is not CoinDCX's agent and cannot represent itself as acting for CoinDCX in any customer-facing copy. Clause 13.2 also names *"network connection failure"* as force majeure - i.e. the venue disclaims the exact failure mode our reconciliation design exists to survive.

#### F11.1 What the Terms mean for Tradex, clause by clause

| Clause | Constraint | Consequence for Tradex |
| --- | --- | --- |
| Preamble + 1.9 | We are a Licensee the moment our servers call the API | We accept these terms in our own right, not only through the customer |
| 1.4 + 6.4 | Tradex is Algorithmic Trading by definition; User warrants it holds any required licences | Legal question for Anand before launch. Blocking for a public launch, not for a private build |
| 2.1 | Licence is **non-sublicensable, non-transferable, revocable** | We cannot pass any API right through to our customers. Each customer must be their own licensee via their own key. Ask CoinDCX in writing whether operating a customer's key is "authorised use" |
| 2.3(a) | No altering or misrepresenting Market Data | Analytics must be clearly labelled as Tradex-derived, and must not restate CoinDCX prices as something else |
| 2.3(c) | **No redistribution or display of Market Data or derived charts/analytics to any third party** | Directly collides with brief requirements 10 and 11. Either treat our customers as not-third-parties (a legal reading we should get confirmed), or source charts from a licensed market-data vendor rather than CoinDCX. See the charting track |
| 2.3(d) | Affiliate use must be disclosed and may be priced | If Tradex is a group of entities, disclose |
| 3.1 | Free today, chargeable at will | Unit economics must tolerate an API fee appearing with no notice |
| 5.2 | Termination without notice, without reason, claims waived | Multi-exchange adapter boundary is a business continuity requirement, not an architectural nicety |
| 5.3(c) | Access revoked for *"activity not authorized by CoinDCX"* | Get written authorisation. An undocumented multi-tenant platform is exposed to this clause |
| 6.6 | **5-year record retention post termination** | Audit/event store must be designed for 5-year retention with legal hold. Affects storage design and cost from Phase 00 |
| 7 | API not warranted safe, uninterrupted or error free | The honest ceiling on requirement 8. Reproduce this in Tradex's customer terms |
| 8 | Protect PII from the API; report intrusions to `legal@coindcx.com` | Makes key security contractual; adds a notification step to the incident runbook |
| 9 | CoinDCX liability capped at **INR 1,00,000 aggregate** | Tradex's customer-facing liability must be capped at or below what Tradex can self-fund |
| 10 | Uncapped indemnity from us to CoinDCX | Insurance question. Also: customer misuse flows to us |
| 11 + 12 | Arbitration seated in Mumbai; Indian law; Mumbai courts | Align Tradex's own terms so we are not fighting on two governing laws |
| 13.1 | No assignment of our obligations to third parties | Vendors/subprocessors need care; an acquisition needs CoinDCX consent for affiliate assignment |
| 13.5 | No principal-agent relationship | Never imply CoinDCX endorsement or partnership in Tradex marketing |

One thing the Terms do **not** say, and this is worth stating plainly because it is the crux: **nothing in the 13 clauses expressly prohibits or expressly permits a platform holding and using another person's API key on their behalf.** The nearest touchpoints are 2.1 (non-sublicensable) and the FAQ note that keys are *"interchangeable"* and may need to be per-user when IP-bound (docs 13920). That silence is a risk, not a permission, and 5.3(c) turns unauthorised activity into instant revocation. The mitigation is cheap: a written question to `api@coindcx.com` describing the model and asking for confirmation, plus the broker-enrolment enquiry. Do it before Phase 01.

### F12. Socket authentication - a different, weaker scheme

Private channels are authenticated at `join` time, not at connect time (VERIFIED docs 6321-6420, 13367-13390).

| Element | Value |
| --- | --- |
| Transport | Socket.IO, `transports: ["websocket"]` |
| Spot endpoint | `wss://stream-spot.coindcx.com` |
| Futures endpoint | `wss://stream.coindcx.com` |
| Signed message | the compact JSON `{"channel":"coindcx"}` - and nothing else |
| Signature | `HMAC-SHA256(body, secret).hexdigest()`, same algorithm as REST |
| Join emit | `socket.emit("join", { channelName: "coindcx", authSignature: <sig>, apiKey: <key> })` |
| Leave emit | `socket.emit("leave", { channelName: "coindcx" })` |
| Keep-alive | `socket.emit("ping", ...)` every 25s; *"Ping check is required to keep the socket connection alive"* |
| Private channel name | `coindcx` |
| Private events | `balance-update`, `order-update`, `trade-update`; futures adds `df-position-update`, `df-order-update` |

The security consequence, stated plainly: **the socket signature contains no timestamp and no nonce.** For a given secret it is a constant. `HMAC("{\"channel\":\"coindcx\"}", secret)` is therefore a permanent bearer token for that account's private stream. It never expires and cannot be rotated without rotating the key. Anything that logs a `join` payload has logged a credential. Treat `authSignature` with the same handling class as the secret itself (see 07).

Golden vector for the socket signature, secret `YYYY` (VERIFIED locally):

```
body: {"channel":"coindcx"}          (21 bytes)
sig : c8f94ab0ff0372da5b20dfa616c8a1abd06341fa2c0ea19559decc4c8485b989
```

The socket.io version contradiction, resolved: the Setup section says *"Please note only version 2.4.0 of this module would work with our Websockets"* (docs 699) but the install command immediately beneath it - obfuscated by Cloudflare email protection in the published HTML, decoded from `data-cfemail` - is `npm install socket.io@4.x.x` (VERIFIED). The Spot Sockets sample carries the comment *"These examples have been tested with the following socket.io version:"* followed by *"1. socket.io-4.x.x.js"* (docs 7684-7685). Two of three sources say 4.x. Use `socket.io-client@4`, and confirm on first connect. The "2.4.0" line is stale prose.

Also note the Setup section says to install `socket.io` (the **server** package) where it means `socket.io-client`; the actual samples import `socket.io-client`.

### Gotchas

Scoped to auth, quotas, paging, errors and terms. Field-level and market-level gotchas are in `01-coindcx-spot-rest.md` (35 of them) and are not repeated.

| # | Gotcha | Evidence |
| --- | --- | --- |
| G1 | `JSON.stringify` emits **exponential notation** below 1e-6 and at/above 1e21: `{"p":1e-7}`, `{"p":1e+21}`. A price or quantity that lands there produces a signed body the exchange will not parse as you intend | VERIFIED Node v24.15.0 |
| G2 | Float arithmetic leaks into the signed bytes: `0.1+0.2` serialises as `0.30000000000000004`; `20000/3` as `6666.666666666667`. Percentage sizing (brief req. 4) produces exactly these | VERIFIED locally |
| G3 | `JSON.stringify` **drops trailing zeros**: `1.10` becomes `1.1`. Precision formatted as a number cannot be preserved; format as a string | VERIFIED locally |
| G4 | Integers above 2^53 are silently corrupted: `9007199254740993` serialises as `...992`. Order ids are numeric strings, so keep them strings and never `parseInt` them | VERIFIED locally |
| G5 | A key whose value is `undefined` is **silently dropped** from the JSON. A bug that leaves `client_order_id` undefined removes idempotency without any error | VERIFIED locally |
| G6 | The official JS sample signs `JSON.stringify(body)` then hands the **object** to `request` with `json: true`, relying on the library producing byte-identical output. Copy that pattern with a different client and you get intermittent 401s | VERIFIED docs 1355-1369 |
| G7 | The Python samples set `Content-Type: application/json` explicitly; the JS samples never do - `request`'s `json: true` sets it. Omitting it still returned 401 (not 415) in our probe, so its necessity on a **successful** call is UNVERIFIED (E6). Always send it | VERIFIED docs 1322 vs 1360; probe |
| G8 | The docs' Python auth sample contains a genuine bug: `secret_bytes = bytes(secret, encoding='utf-8')` immediately followed by an unguarded `secret_bytes = bytes(secret)` (the "python2" line is not commented out in the Authentication sample, though it is in later ones). On Python 3 the second line raises `TypeError` | VERIFIED docs 1300-1303 vs 1680-1683 |
| G9 | HMAC must be over **UTF-8 bytes**. `'café'.length` is 4 but `Buffer.byteLength` is 5. Any non-ASCII in a `client_order_id` makes a length-based `Content-Length` wrong | VERIFIED locally |
| G10 | The signature does not cover the path. Posting an order body to the wrong URL yields **404, not 401** - and a wrong HTTP **method** also yields 404, not 405 | VERIFIED by probe |
| G11 | The docs contain authenticated **`requests.get(url, data=json_body, ...)`** samples for several futures endpoints while the JS sample for the same endpoint uses POST. Follow the Authentication section: POST always | VERIFIED docs 11865, 12055, 12411, 12555, 13254 vs 1280 |
| G12 | `timestamp` is milliseconds in every executable sample and "seconds" in four prose/table locations, including a `# EPOCH timestamp in seconds` comment sitting directly above `time.time() * 1000` | VERIFIED docs 1690 |
| G13 | Parameter-table example timestamps are 10-digit (`1524211224` = seconds). Copying an example value verbatim sends a 2018 timestamp | VERIFIED docs 2215 |
| G14 | The staleness window is undocumented, and the rejection body is undocumented. A clock-skew failure may be indistinguishable from a bad key, so we would tell a customer their key is wrong when our host drifted | VERIFIED docs 1282 (absence) |
| G15 | Rate-limit feedback headers are lowercase `ratelimit` / `ratelimit-policy`, not `X-RateLimit-*`, and are documented nowhere. Code that looks for `X-RateLimit` concludes there is no feedback | VERIFIED by probe |
| G16 | `ratelimit: reset=8` is **seconds remaining**, not a Unix timestamp. Treating it as epoch schedules a retry in 1970 | VERIFIED by probe |
| G17 | On `cf-cache-status: HIT` the `ratelimit` counters belong to someone else's request. Meter only off `DYNAMIC`/`BYPASS` responses | VERIFIED by probe |
| G18 | `Retry-After` is never sent on 429. All backoff timing is ours | VERIFIED absent, docs and 14 live responses |
| G19 | `cancel_all` is capped at **30/60s** - 66x tighter than create. A 100-account emergency flatten cannot use it inside one minute | VERIFIED docs 741 |
| G20 | Pagination metadata lives in the `x-pagination` **response header**, not the body. Any client wrapper that discards headers destroys paging | VERIFIED docs 6217 |
| G21 | Four different page defaults: 100 (generic), 10 (margin table), 200 (active orders, also the max), 500 (trade history `limit`, also the max). The parameter is `size` in three places and `limit` in two | VERIFIED docs 6206, 5955, 2988, 3176, 1081 |
| G22 | `orders/trade_history` is **cursor-paged on `from_id`**, not page-paged. A page-loop against it silently re-reads page 1 | VERIFIED docs 3178 |
| G23 | **422 is returned but is not in the documented status list.** Code that switches exhaustively on the documented six will fall through | VERIFIED docs 14077-14111 vs 1786 |
| G24 | The error envelope is not uniform. `errorCode` appears on some routes (`BFF-AUTH-001`, `BFF-SO-004`) and not others, for the same logical failure | VERIFIED by probe |
| G25 | A futures error row pairs **HTTP 500** with the reason *"Invalid input"* - a deterministic client error surfaced as a server error. Therefore "retry all 500s" is unsafe | VERIFIED docs 9209 |
| G26 | *"Insufficient funds"* is **HTTP 400**, not 402/422 - and it is the most likely per-account failure in a group trade | VERIFIED docs 9166, 1811 |
| G27 | Malformed JSON is rejected (400 `bad_request`) **before** credentials are checked, so a 400 says nothing about the key | VERIFIED by probe |
| G28 | Acceptance is not terminal: *"an order could be placed but rejected at a later stage"* if a market order's value falls below min notional | VERIFIED docs 14025 |
| G29 | Cloudflare Bot Management fronts the API (`__cf_bm` set on every response). A challenge returns **HTML, not JSON**. Check `content-type` before parsing; classify non-JSON as indeterminate | VERIFIED by probe |
| G30 | The socket `authSignature` has **no timestamp** - it is a permanent bearer token derived from the secret. Never log a `join` payload | VERIFIED docs 6332 |
| G31 | Setup says socket.io **2.4.0** only; the install command beneath it says **4.x.x** and the samples say they were tested on 4.x. Also it names `socket.io` where it means `socket.io-client` | VERIFIED docs 699-706, 7685 |
| G32 | The FAQ says futures is not available via API, while the same document documents ~5,500 lines of futures endpoints. Do not use the FAQ as an availability oracle | VERIFIED docs 13954 vs 7779+ |
| G33 | The docs have **no version marker and no changelog**. A breaking change is silent | VERIFIED by absence |
| G34 | `new Buffer(...)` in the official JS samples still runs on Node 24 but emits `DEP0005`. Use `Buffer.from` | VERIFIED Node v24.15.0 |
| G35 | `x-request-id` was present on 13 of 14 probe responses but absent on one (`orders/create` 401). Log it when present; do not require it | VERIFIED by probe |

## Design

### D1. The signer - one function, one string, no second serialisation

```
// Every value is already a string or a safe integer. No JS floats reach here.
type Scalar = string | number | boolean;
type Body   = Record<string, Scalar | Scalar[] | Record<string, Scalar>[]>;

function canonicalBody(fields: Body, nowMs: number): string {
  const withTs = { ...fields, timestamp: nowMs };   // integer ms, safe < 2^53
  assertNoUndefined(withTs);                        // G5
  assertNoFloats(withTs);                           // G1, G2, G3
  return JSON.stringify(withTs);                    // compact by default; no spaces
}

function sign(bodyString: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(bodyString, 'utf8')                     // G9
    .digest('hex');                                 // lowercase hex
}

async function call(path: string, fields: Body, cred: Credential) {
  const bodyString = canonicalBody(fields, clock.nowMs());
  const signature  = sign(bodyString, cred.secret);
  return http.post(BASE + path, {
    body: bodyString,                               // the SAME string. never the object. G6
    headers: {
      'Content-Type': 'application/json',
      'X-AUTH-APIKEY': cred.key,
      'X-AUTH-SIGNATURE': signature,
    },
  });
}
```

`assertNoFloats` is the money guard: it rejects any value of JS type `number` other than the `timestamp` integer. Prices, quantities and amounts must arrive as decimal strings from the sizing layer. This is what makes G1-G4 unreachable rather than merely documented.

`assertNoUndefined` walks the object and throws on any `undefined` value, because `JSON.stringify` would silently drop the key. The specific disaster it prevents: a missing `client_order_id`, which silently converts an idempotent create into a non-idempotent one.

### D2. Golden vectors for the signer unit test

Computed locally with `secret = "YYYY"` (VERIFIED, Node v24.15.0). These let the signer be tested with zero exchange access and zero real credentials.

| Body string | Bytes | Expected signature |
| --- | --- | --- |
| `{"timestamp":1756900000000}` | 27 | `60574fbeb0b539c4c416354148c5ea2434511b51f8d9940c9786ff3435afa5eb` |
| `{"side":"buy","order_type":"limit_order","market":"SNTBTC","price_per_unit":"0.03244","total_quantity":"400","timestamp":1756900000000,"client_order_id":"tdx-01J000000000000000000000"}` | 184 | `652d87925ff106ad5b2b1bc828d4bb688bcb53e8258f3179313057d5798cb424` |
| `{"channel":"coindcx"}` | 21 | `c8f94ab0ff0372da5b20dfa616c8a1abd06341fa2c0ea19559decc4c8485b989` |

Add three negative tests to the same suite: a float that serialises exponentially, a float with representation error, and an `undefined` optional field. Each must throw before signing.

### D3. Clock discipline

Because the staleness window is undocumented and the skew symptom is probably indistinguishable from a bad key (G14), we cannot detect skew from CoinDCX's answers. We must guarantee it from our side.

```
                 +-----------------------------+
   NTP  ------->  |  offsetMs, lastSyncAt      |  sampled every 30s
                 +-----------------------------+
                              |
                    clock.nowMs() = Date.now() + offsetMs
                              |
        +---------------------+---------------------+
        | |offsetMs| > 2000  OR  age(lastSync) > 60s |
        +---------------------+---------------------+
                              |
                      REFUSE TO SIGN
              (fail the intent as NOT-SENT, alarm)
```

- Refusing to sign is the safe failure: a not-sent order is recoverable, a rejected-for-unknown-reason order is not.
- 2s and 60s are opening guesses; tighten to a fraction of the measured window once E2 returns a number.
- Never surface "invalid API key" to a customer unless clock health was green at the moment of the 401. Otherwise the message is a lie a third of the time.

### D4. The rate limiter

Two buckets, both consulted before every call, because we do not yet know which one the server enforces (E1):

| Bucket | Key | Seed | Source of truth |
| --- | --- | --- | --- |
| Principal | api-key | 100 / 60s | tightest published figure (F6.1 claim 3) |
| Egress | source IP | 100 / 60s, shared across all customers | same, until E1 |
| Route | (api-key, path) | the F6.3 per-endpoint number | docs table |

Closed-loop adjustment: when a response carries `ratelimit`, and `cf-cache-status` is not `HIT`, replace the bucket's ceiling and remaining with the header values (G16, G17). When it does not, decay conservatively.

Two consequences to design around now:

- **Fan-out is serialised by the limiter.** At 100/60s a 100-account group trade takes ~60s if the budget is per-IP and ~1s if it is per-key. The UI must therefore show per-account progress and per-account outcomes from the first version - a group trade is a long-running job with partial results, not a request. That is also exactly what the brief's "partial group failure is a first-class outcome" requires.
- **Emergency flatten cannot use `cancel_all`.** At 30/60s, flattening 100 accounts takes 200 seconds. The panic path must instead use `cancel_by_ids` (300/60s, 10 ids per call) against ids we already hold, which is another reason our own order store must be authoritative and complete. Reserve a standing share of the budget for the panic path so a busy trading minute cannot starve it.

### D5. The error classifier

```
classify(httpStatus, contentType, body, requestKind) ->
  | ACCEPTED           // 200 with a usable payload
  | REFUSED(reason)    // exchange said no, definitively, before matching
  | INDETERMINATE      // we do not know. never retry a create on this
  | OUR_BUG            // 400 bad_request, 404 not_found

rules, in order:
  contentType not JSON            -> INDETERMINATE   (G29)
  status 200                      -> ACCEPTED
  status 400 && message == 'bad_request' -> OUR_BUG  (G27)
  status 404                      -> OUR_BUG         (G10)
  status 400 or 422               -> REFUSED(substringTable(message))
  status 401                      -> REFUSED('credentials') + clockHealthCheck (D3)
  status 429                      -> INDETERMINATE, backoff
  status 500 or 503               -> INDETERMINATE   (G25 forbids blanket retry)
  transport error / timeout       -> INDETERMINATE
```

`INDETERMINATE` on a create has exactly one resolution and it is never a resend:

```
create(clientOrderId) --INDETERMINATE--> wait 1s
   -> orders/status { client_order_id }
        found     -> adopt the exchange's state. done.
        not found -> retry once more after backoff; if still not found
                     after N attempts, mark the leg NEEDS-HUMAN and alarm.
```

`substringTable` is a versioned, tested map from message fragments to reasons, seeded from F9.4 and F9.5. Unknown fragments map to `REFUSED('unknown')` and raise a low-priority alarm so the table grows from production rather than from guesses.

### D6. What every call must persist

Five-year retention is a contractual obligation (clause 6.6), so the record is designed once, now.

| Field | Why |
| --- | --- |
| `intent_id`, `account_id`, `leg_id` | ties the call to the group trade |
| `client_order_id` | the idempotency key and the lookup handle |
| method, path | route audit; the signature does not cover these (G10) |
| body **length and SHA-256**, never the body | the body contains no secret, but its signature does; store a digest so we can prove what we sent without storing a replayable pair (F3) |
| `X-AUTH-APIKEY` **fingerprint** only | never the key, never the secret, never the signature. See 07 |
| our `timestamp` value + clock offset at signing | makes a future skew post-mortem possible |
| HTTP status, `code`, `message`, `errorCode` | classification input |
| `x-request-id` | the only handle CoinDCX support can act on (G35) |
| `ratelimit`, `ratelimit-policy`, `cf-cache-status` | limiter telemetry and post-hoc quota forensics |
| `x-runtime`, kong/envoy latencies, our own elapsed | separates our latency from theirs |
| classification outcome | ACCEPTED / REFUSED / INDETERMINATE / OUR_BUG |

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
| --- | --- | --- | --- |
| Body re-serialised by the HTTP client, signature no longer matches the bytes sent | 401 `Invalid credentials` on a key that worked yesterday; reproducible only for bodies with certain key sets | Sign a string, send that string (D1). Assert in an integration test that the client sends `Content-Length == Buffer.byteLength(bodyString)` | Every order on every account. Total outage of trading |
| Our host clock drifts past the undocumented window | 401 while clock health is red | Refuse to sign when offset > 2s or last NTP sync > 60s (D3) | All accounts, all orders, until corrected. Presents as "all customer keys invalid" |
| Clock skew misreported to the customer as an invalid key | Support tickets saying "my key works on the CoinDCX site" | Never emit "invalid key" unless clock health was green at signing time | Trust. Customers rotate keys that were never broken |
| Quota is per-IP, not per-key (E1 unanswered) | 429 on account B immediately after a burst on account A | Two-bucket limiter (D4); egress IP pool; HFT tier with a static Trusted IP (F6.4) | Group trades degrade from ~1s to ~60s for 100 accounts. Fairness between customers breaks |
| 429 mid fan-out on a create | classifier returns INDETERMINATE | Never resend; resolve by `orders/status` on `client_order_id` (D5) | One leg per occurrence. Without the lookup: a duplicate order, i.e. double exposure |
| 500/503 or timeout on a create | classifier returns INDETERMINATE | Same lookup path. Alarm if unresolved after N attempts | One leg. This is the classic duplicate-order source |
| A 500 that actually means "Invalid input" is retried forever | Same request failing 500 repeatedly with identical inputs | Cap attempts; move to NEEDS-HUMAN; never treat 5xx as transient by class (G25) | One leg, plus wasted budget that starves other legs |
| Cloudflare challenge returns HTML | `content-type` is not JSON | Classify as INDETERMINATE, do not parse, alarm immediately - a challenged egress IP affects every customer | All accounts until the challenge clears |
| Wrong method or path ships to production | 404 `not_found` on a route that "exists" | Contract tests that assert POST and the exact path for every endpoint; 404 classified as OUR_BUG, not as retryable (G10) | Whole endpoint dead. Looks like a CoinDCX outage; wastes an incident |
| `client_order_id` silently `undefined` | Absent from the persisted body digest; duplicate orders appear under retry | `assertNoUndefined` before signing (D1); schema-require the field in the adapter | Idempotency lost across every retry path |
| `client_order_id` exceeds 36 chars | Rejection with an undocumented message | Generate a fixed 30-char scheme and unit-test the length (F7) | Every create refused |
| Float sizing corrupts the signed amount | Golden-vector and `assertNoFloats` tests | Decimal strings end to end (D1, G1-G4) | Wrong size, real money. The brief's "no wrong size" property |
| Paging header discarded by an HTTP wrapper | Backfill silently returns page 1 forever; totals never reconcile | Parse `x-pagination`; assert `total` decreases to zero across the loop (F8, G20) | Silent history gaps -> wrong P&L and wrong reconciliation |
| Page-loop applied to the cursor-paged `orders/trade_history` | Duplicate trades; `total` never satisfied | Cursor on `from_id` (G22) | Duplicated fills -> inflated P&L |
| `cancel_all` budget exhausted during an emergency | 429 on the panic path | Panic path uses `cancel_by_ids` with our own ids; reserve standing budget (D4) | Cannot flatten. Unbounded market exposure. The worst failure in this table |
| 25-open-orders-per-market cap hit | Rejection on the 26th | Count open orders per (account, market) in our own state; refuse locally first (F7) | One account's strategy stalls |
| Order accepted then rejected asynchronously | `status` transitions to `rejected` after a 200 | Treat accepted as non-terminal; reconcile every leg to a terminal state (G28) | Believed-open position that does not exist. Silent divergence |
| Docs change silently (no version marker) | Weekly hash diff of the docs HTML in CI (G33) | Alert and re-verify the affected section before shipping | Any contract assumption in any track |
| CoinDCX terminates access without notice (clause 5.2) | 401/403 across all keys at once | Adapter boundary kept real from day one; second exchange spiked early | Whole product offline. No contractual recourse (claims waived) |
| Charts/analytics found to breach clause 2.3(c) | Notice from CoinDCX, or clause 5.3 revocation | Written clarification before launch; be ready to source market data from a licensed vendor | Feature removal, or access revocation |
| Audit store cannot satisfy 5-year retention (clause 6.6) | Retention audit | Design the event store for 5-year retention with legal hold from Phase 00 | Contractual breach; also breaks any dispute defence |
| Socket `authSignature` leaked from a log | Log scan for `authSignature` / `join` payloads | Redact at the logger; treat as secret-class (G30) | Permanent read access to that account's private stream until the key is deleted |
| Key used from an IP-bound key on our servers | Consistent auth failure for one customer only, from the first call | Detect at onboarding: probe `users/balances` immediately and tell the customer to create an unbound key | One customer cannot onboard. Cheap if detected at onboarding, expensive if at first trade |

## Open questions for Anand

1. **Legal: is a multi-account platform on customer keys authorised use?** Clause 2.1 is non-sublicensable, clause 5.3(c) revokes access without notice for *"activity not authorized by CoinDCX"*, and nothing in the 13 clauses addresses the model either way. Do we write to `api@coindcx.com` describing Tradex and asking for written confirmation, and do we simultaneously open the broker-enrolment conversation? My recommendation: yes to both, before Phase 01.
2. **Clause 2.3(c) vs the charts and analytics requirements.** The clause prohibits displaying Market Data or derived charts and analytics *"to any third party"*. Requirements 10 and 11 are exactly that. Options: (a) get written confirmation that our customers are not third parties for this purpose; (b) source chart data from a licensed vendor and use CoinDCX only for execution; (c) show only the customer's own fills, never market data. Which do we plan for?
3. **Algorithmic-trading licensing (clause 6.4).** The User warrants it holds any licences Applicable Law requires for Algorithmic Trading, and clause 1.4's definition covers Tradex. Is counsel confirming that no Indian licence is required, and by when?
4. **India-only eligibility.** CoinDCX states API access requires an Indian citizen or Indian entity. Is Tradex's target market accordingly India-only for v1, and is that stated in our own terms?
5. **Liability posture.** CoinDCX caps its liability to us at INR 1,00,000 aggregate while our indemnity to them is uncapped. What cap goes in Tradex's customer terms, and do we want professional-indemnity cover before we take a paying customer?
6. **HFT tier.** It is the documented answer to a rate-limit ceiling and it needs a static IP and an enterprise conversation. Do we pursue it now (it also gives us the static egress IP the architecture wants anyway) or wait for E1 to prove we need it?
7. **Do we require customers to create unbound keys?** IP-bound keys cannot be used from our servers. Requiring unbound keys is a real security downgrade for the customer. The alternative is publishing our static egress IPs and asking them to bind to those - better security, but it hard-couples us to those addresses. My recommendation: static egress IPs plus binding, which also aligns with the HFT tier.

## Phase hints

| Phase | Owns | Must precede it |
| --- | --- | --- |
| Phase 00 - foundations | Run E1-E5 against a throwaway CoinDCX account with a small INR balance. Build the signer with the D2 golden vectors, the clock guard (D3) and the audit record (D6) including 5-year retention | A real account and a funded key. Nothing else in this doc can be finalised without E1 and E2 |
| Phase 00 - legal, parallel | Send the written questions to `api@coindcx.com` (Q1), open broker enrolment, get counsel on Q2 and Q3 | Anand's decisions on the Open Questions |
| Phase 01 - exchange adapter | The `CoinDCXClient`: canonical body, signer, two-bucket limiter (D4), error classifier (D5). No business logic | Phase 00's signer and E1's answer, which sets the limiter's shape |
| Phase 01 - onboarding probe | On adding an account, immediately call `users/balances` to validate the credential and detect IP binding | The adapter |
| Phase 02 - order lifecycle | Idempotent create with a deterministic `client_order_id`; the INDETERMINATE resolution loop; open-orders-per-market counter | E5 (duplicate `client_order_id` behaviour) |
| Phase 02 - reconciliation | Cursor-paged `orders/trade_history` backfill and `x-pagination` handling; treat accepted as non-terminal | E4 (which endpoints emit `x-pagination`) |
| Phase 03 - group fan-out | Per-leg progress and per-leg outcomes as a first-class UI concept; partial failure reporting | The limiter's real capacity from E1 |
| Phase 03 - panic path | Emergency flatten via `cancel_by_ids` with reserved budget, never `cancel_all` | Our own authoritative order store |
| Phase 04 - private sockets | Socket.IO 4.x client, `join` auth, 25s ping, `authSignature` redaction | Confirmation that 4.x connects (G31) |
| Ongoing - CI | Weekly hash-diff of `docs.coindcx.com` and alert on change | Nothing |

Experiments referenced above, all requiring one real key on a throwaway account:

| Id | Question | Method |
| --- | --- | --- |
| E1 | Is the quota per API key or per source IP? | Two keys on two accounts from one IP. Drive key A at ~5/s of `users/balances` until 429, then immediately call key B once. If B is also limited, the bucket is IP-keyed |
| E2 | What is the timestamp staleness window, and what does a skew rejection look like? | `users/balances` with `timestamp` at now, -10s, -30s, -60s, -300s, +30s, +300s. Record status, `code`, `message`, `errorCode` for each |
| E3 | Do authenticated 200s carry `ratelimit` headers? | One successful `users/balances`; dump every response header |
| E4 | Which endpoints emit `x-pagination`? | `orders/active_orders` and `orders/trade_history` at page 2 / with `from_id`; dump headers |
| E5 | What does a duplicate `client_order_id` return? | Place a 1-rupee limit buy far below market with `client_order_id = X`; cancel it; then re-send the identical body. Record status, `code`, `message`, `errorCode`. Repeat once without cancelling first |
| E6 | Is `Content-Type: application/json` actually required? | One successful call with the header omitted |
| E7 | Does `page=0` error, clamp, or return out_of_bounds? | `margin/fetch_orders` with `page: 0` |

E5 is the only experiment that places a real order. Use the smallest legal notional on an INR market, a limit price far from the market so it cannot fill, and cancel it immediately.

## Sources

Local ground truth - `C:/Users/anand/Tradex/research/_sources/coindcx-docs.txt` (14,111 lines), read in full over these ranges:

| Lines | Section |
| --- | --- |
| 396-538 | Terms and Conditions, all 13 clauses |
| 539-660 | Introduction, Terminology |
| 660-766 | Setup, SPOT API Rate Limits |
| 1070-1098, 1250-1278 | public trades and candles `limit` caps |
| 1278-1405 | Authentication |
| 1406-1512 | Get balances |
| 1596-1618 | Get user info (PII) |
| 1618-1830 | Sub Account Transfer + its error table |
| 1920-2020 | Wallet Transfer + its error table |
| 2043-2320 | New order (25-open-orders cap, `client_order_id` semantics) |
| 2319-2545 | Create multiple orders (10-order cap, INR-only) |
| 2660-2700, 2810-2862 | Order status, Multiple order status |
| 2975-3045 | Active orders (200/200 paging) |
| 3150-3220 | Account Trade history (cursor paging) |
| 3320-3360, 3450-3500 | Active orders count, Cancel all |
| 3560-3625 | Cancel multiple by ids |
| 3712-3760, 3855-3918 | Cancel, Edit Price |
| 5920-5965, 6120-6147 | Margin fetch orders / query order paging |
| 6147-6229 | Pagination |
| 6230-6450 | Spot Sockets, private channel auth |
| 7617-7780 | Socket sample code, ping, version notes |
| 8839-8905, 9121-9210 | Futures create order + its error table |
| 10151-10180, 10438-10478 | Futures leverage / margin error tables |
| 11985-12080 | Cross margin details (the POST-vs-GET contradiction) |
| 13323-13400 | Futures sockets, ACCOUNT channel auth |
| 13899-14076 | FAQ, in full |
| 14077-14111 | Errors |

External, all fetched 2026-09-03 with `curl -A "Mozilla/5.0 ..."`:

- https://docs.coindcx.com/ - re-fetched to confirm the local copy is current
- https://coindcx.com/api/help/Error%20Codes%20and%20Resolution/ - the *"100 requests per minute"* figure
- https://coindcx.com/api/help/High%20Frequency%20Trading/ - `hft-api.coindcx.com`, Trusted IP
- https://coindcx.com/api/help/API%20Dashboard/Generation%20of%20Key%20and%20Secret - OTP, IP binding, secret shown once
- https://coindcx.com/api/help/API%20Dashboard/Managing%20the%20API%20Keys - deletion is permanent
- https://coindcx.com/api/help/ - API scope overview
- https://coindcx.com/api/help/sitemap.xml - page enumeration
- https://info.coindcx.com/api/ - India-only eligibility, broker enrolment, HFT access, no official SDK

Live probes against `https://api.coindcx.com`, 2026-09-03, unauthenticated, no order placed:

- `POST /exchange/v1/users/balances` with fake key + fake signature -> 401 envelope, full header dump
- `POST /exchange/v1/users/balances` with no auth headers -> 401 envelope
- `POST /exchange/v1/orders/create` with fake credentials -> 401 with `errorCode: BFF-AUTH-001`
- `POST /exchange/v1/users/balances` with malformed JSON -> 400 `bad_request`
- `GET /exchange/v1/users/balances` -> 404 `not_found` (wrong method, not 405)
- `POST /exchange/v1/users/balances_nope` -> 404 `not_found`
- `GET /exchange/ticker`, `GET /exchange/v1/markets`, `GET /market_data/orderbook?pair=B-BTC_USDT` -> `ratelimit-policy: 5000;w=60`

Local reproductions on Node v24.15.0: `JSON.stringify` number serialisation (G1-G4), `undefined` dropping (G5), `Buffer.byteLength` vs `String.length` (G9), `new Buffer` deprecation (G34), and the three HMAC golden vectors in D2.

Related Tradex docs: `01-coindcx-spot-rest.md` (endpoints, enums, order object, market legality), `07-api-key-security.md` (key custody and encryption).
