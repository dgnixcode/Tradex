# 18 - Testing and correctness program

Status: 2026-09-03 | track: platform | scope: how we earn the right to send a real order, given that CoinDCX offers nowhere safe to practise.

## Verdict

- **There is no CoinDCX sandbox, testnet, demo account or paper-trading mode. Verified: zero matches for any of those terms across the entire 14,119-line API reference.** Every authenticated call we ever make in anger is against a live account with real money. That single fact reshapes the whole strategy: the substitute for a sandbox is a **fake exchange we build**, plus a staged rollout on real money with hard caps, in that order.
- **Everything that can be a pure function must be, because pure functions are the only things we can test exhaustively.** Sizing and legalisation (`09` F5), the ledger fold (`11` F5), status mapping (`12` F1) and the money type carry almost all of the money-losing risk, and none of them needs I/O. Property-testing them against **all 999 live markets** is the highest-value testing work in the plan and it can be done before a single order exists.
- **The invariants are already written. This document's job is to turn them into executable checks.** Six other documents specify 55 numbered invariants (F3). Each becomes a test with the same identifier, so a failure names the design rule it broke rather than an assertion line number.
- **Deterministic fault simulation replaces the sandbox for the engine.** The failure modes that actually cost money - lost responses, duplicate replies, 429 storms, out-of-order socket events, a worker killed mid-fan-out, clock skew - are all injectable against the fake exchange, and none of them is reproducible on a real exchange on demand.
- **The rollout ladder has numeric gates, not judgement calls.** Dry-run, then one account at Rs 100, then one account at Rs 1,000, then two accounts, then five, then the group - each rung with a stated pass condition and a stated blocker. "It looked fine" is not a graduation criterion.
- **Kill switches and caps are product features, tested as such.** A cap that only exists in an ops console is a cap nobody can reach at 2am. Global, tenant, account and market switches, each independently exercised by a test that asserts an order is *not* sent.
- **The canary test for secret leakage is the first test to write.** Drive a sentinel credential through the entire stack and assert it appears in zero log lines, zero error payloads and zero HTTP responses (`07` F6). It is cheap, it proves a property nothing else proves, and the failure it prevents is the one that ended a competitor's reputation (`16` F1).

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Sandbox substitute | A **fake exchange** built from the docs contract plus captured real responses | None exists (F1) | Test against production with small amounts only - necessary later, insufficient alone |
| Fake exchange fidelity | Contract-accurate on shapes, enums, error codes and limits; deliberately *hostile* on timing and failure | Its purpose is to be worse than reality, not the same as it | A friendly mock that always succeeds |
| Test taxonomy | Unit → property → simulation → check scripts → staged live | Each layer catches what the previous cannot | One big integration suite |
| Property testing | `fast-check` over generated inputs **and** over all 999 real market metadata rows | Real metadata contains the pathological cases (`DOGEINR` step 1, precision 0) | Generated inputs only |
| Check scripts | Standalone runnable Node scripts printing assertion counts, one per phase, mirroring the owner's other codebase | Runnable in isolation during an incident; a phase's definition of done cites its check name | A single test runner only |
| Live testing | Staged ladder with hard per-order caps enforced in code, not config | Config can be edited in a hurry; code needs a deploy | A "be careful" convention |
| Kill switches | Product features with their own tests | An untested switch is a switch that fails when used | Ops-only tooling |
| Secret-leak testing | Canary sentinel through the full stack, in CI | Nothing else proves absence of leakage | Code review |
| Snapshot/golden files | Execution reports and preview tables, stored and diffed | Catches unintended changes to the numbers a customer sees | Assert individual fields |
| Real-money test funds | A dedicated account funded with **Rs 2,000**, never more, for the ladder's lower rungs | Bounded loss if everything is wrong | Test on a customer's account, or on a large own account |
| CI gate | Typecheck, lint, unit, property, simulation and all check scripts must pass; no exceptions, no `--force` | The failure cost is money | Allow overrides for urgent fixes |

## Findings

### F1 - There is no sandbox, and the evidence

Searched the full docs dump for `sandbox`, `testnet`, `test net`, `demo account`, `paper trad` - **zero matches**. VERIFIED, 2026-09-04. Nor is any test environment mentioned in the FAQ, the Setup section or the help pages read for `07`.

What that removes and what remains:

| Normally you would | Here |
|---|---|
| Place thousands of practice orders | Impossible |
| Verify signing against a test key | Signing must be verified against a **read-only** live call (`users/balances`) - which is safe, cheap and idempotent |
| Exercise error paths by asking the sandbox for them | Must be simulated locally; the real exchange will not produce a 429 or a lost response on request |
| Test cancel/partial-fill flows | Only reproducible with tiny real limit orders far from the market, which is a genuine technique but slow and rate-limited |
| Load-test | Never against production. The rate-limit experiment (`08` F1) is the only sanctioned live probing, and it uses read endpoints |

The one genuinely safe live tool is **`users/balances`**: authenticated, read-only, no side effects. Signing correctness, credential validity, clock skew and the per-key-versus-per-IP rate-limit question can all be settled with it without risking a rupee. Everything else is either fake-exchange work or graduated real-money work.

### F2 - The fake exchange

A local HTTP server plus a socket.io server implementing the contract from `01`-`06`. Its value comes from being *worse* than CoinDCX on purpose.

| Capability | Detail |
|---|---|
| Contract accuracy | Exact request validation, exact response shapes, the real enum strings including `partially_cancelled`, the real error codes and messages, the documented limits |
| Real fixtures | Captured live responses for `markets_details` (999 rows), `ticker`, `orderbook`, `candlesticks` - so tests run against the pathological real data, not tidy invented data |
| Fault injection | Per-scenario: latency, timeout with the order **accepted anyway**, timeout with it rejected, duplicate response, 429 with and without a retry hint, 500, 503, connection reset mid-body, malformed JSON, an unknown status string, a fractional-millisecond timestamp, a fill arriving before the create response |
| Statefulness | Tracks orders, enforces `client_order_id` uniqueness, fills limit orders when a scripted price crosses, supports partial fills |
| Socket behaviour | The verified pathologies from `05`: silent accept of a wrong channel name, silent disconnect on bad auth, `data` as a stringified JSON, exponent-form numbers, a missing candle event |
| Determinism | Seeded; a failing simulation replays exactly |

Two fixtures matter more than the rest. **`DOGEINR`** (`min_quantity` 0.001, `step` 1, `target_currency_precision` 0) is the market that proves the effective-minimum rule is a maximum. **`BTCINR`** (`max_quantity` 2 but `max_quantity_market` 0.0158) is the market that proves large accounts fail first. Any sizing change must be run against both.

### F3 - The invariant inventory

Fifty-five numbered invariants already exist across the research. Each becomes a test carrying the same id.

| Set | Source | Count | Nature |
|---|---|---|---|
| `S1`-`S10` | `09` sizing | 10 | Property tests over all 999 markets |
| `L1`-`L11` | `11` ledger | 11 | Property tests over generated fill sequences |
| `R1`-`R10` | `12` reconciliation | 10 | Simulation tests with fault injection |
| `I1`-`I10` | `08` engine | 10 | Simulation tests |
| `C1`-`C6` | `10` currency | 6 | Property + type-level tests |
| `V1`-`V8` | `13` charting | 8 | Unit + snapshot tests |
| `N1`-`N8` | `14` analytics | 8 | Unit tests over fixtures |
| `U1`-`U10` | `21` UI | 10 | Component + one end-to-end (`U2`) |
| Total | | **73** | |

The five whose failure would be most expensive, and therefore the five to write first:

| id | Invariant | Why first |
|---|---|---|
| `I1` | At most one exchange order per `(group_trade_id, account_id, leg_seq)`, forever | Duplicate real-money orders |
| `R8` | After restart, every `sending`/`ambiguous` order is resolved before any new order for that account | The restart-duplicate bug |
| `S1` | A buy's `quantity × price × (1+fee)` never exceeds the stated budget | Spending more than authorised |
| `S2` | A sell never exceeds the exchange-reported free holding | Overselling |
| `R10` | The reconciler never throws | A silent, total loss of the safety net |

### F4 - Property tests over real market data

The single highest-value suite. Load the captured 999-row `markets_details` fixture and, for every market, generate intents and assert the sizing output.

```
for each of 999 markets:
  for 200 generated intents (mode, value, side, balance, holding):
      out = size(intent, market, price, balances, holdings)
      if out is Sized:
          assert out.qty is an exact multiple of market.step                    # S3
          assert decimals(out.qty) <= market.target_currency_precision          # S3
          assert out.qty >= effective_min_qty(market, intent.order_type)        # S4
          assert out.qty <= effective_max_qty(market, intent.order_type)        # S4
          assert out.qty * price >= market.min_notional                         # S5
          if side == BUY:  assert out.notional * (1+fee+tds) <= budget          # S1
          if side == SELL: assert out.qty <= holdings.free                      # S2
      else:
          assert out.reason is a known code with a human sentence               # S10
      assert no float appears in the serialised output                          # S6
```

Plus two relational properties that catch whole classes of bug:

| Property | Statement |
|---|---|
| `S8` monotonicity | A larger budget never yields a smaller quantity |
| `S9` determinism | Identical inputs yield identical output, run twice, in either order |

Roughly 200,000 cases per run, no I/O, seconds to execute. If `min_market_orders_qty` is absent (it is, on every market sampled - `09` F6), the suite proves the fallback works across the whole market universe rather than on one hand-picked row.

### F5 - Deterministic simulation of the engine

Drive the real engine against the fake exchange with a seeded fault schedule, then assert the invariants held.

| Scenario | Injected | Must hold |
|---|---|---|
| Lost response, order accepted | Timeout after the fake exchange records the order | `I1` - resolve adopts it; exactly one order exists |
| Lost response, order not accepted | Timeout before recording | Resolve reports `not_placed`; a re-send with the same `coid` succeeds |
| Duplicate `client_order_id` | Second send of the same `coid` | Rejected by the fake exchange; our state stays single |
| Worker killed mid-fan-out | Process kill after 7 of 20 sends | `R8` - on restart, the 7 are resolved, the 13 proceed, zero duplicates |
| 429 storm | Every third call throttled | No business rejection retried (`I7`); all children reach terminal |
| Out-of-order socket events | Stale `updated_at` after a fresh one | `R3`, `R4` - no regression, no re-opened terminal |
| Unknown status string | `"weird_state"` returned | `R5`, `R10` - `unknown` + alarm, reconciler survives |
| Fill before create response | Socket fill event precedes the HTTP reply | Fill ingested once; order adopted correctly |
| Clock skew | Signing clock offset by 15 s | Futures rejected with a distinct signature error and alarmed, not misread as a credential fault |
| Partial group failure | 3 of 20 rejected for min notional | Group completes; report shows 17/3 with reasons; `I4`, `I9` |

The worker-kill scenario is the one to automate first and run on every push. It is the exact shape of the bug that produces duplicate real-money orders, and it is untestable by any other means.

### F6 - The staged rollout ladder

Every rung has a numeric gate. A rung is not passed by inspection.

| Rung | What | Cap | Pass condition | Blocked by |
|---|---|---|---|---|
| 0 | **Dry run / shadow.** Full pipeline, gates, sizing, preview, signing - the send is suppressed | Rs 0 | 100 consecutive group trades planned with zero exceptions; preview equals what would have been sent (`U2`) | - |
| 1 | **One account, one order** | Rs 100 per order, hard-coded | Order reaches `filled`; ledger balances (`L2`); reconciliation clean; fee recorded from the real `fee` field | Rung 0 |
| 2 | **One account, ten orders** including a cancel and a partial fill | Rs 100 per order | All ten terminal; `L1` replay reproduces holdings exactly; one cancel verified from `open` | Rung 1 |
| 3 | **One account, larger** | Rs 1,000 per order | As rung 2, plus slippage recorded against decision-time mid (`M16` non-null) | Rung 2 |
| 4 | **Two accounts, one group** | Rs 1,000 per order, Rs 2,000 per group | Both children terminal; execution report correct; `M19` divergence computed | Rung 3 |
| 5 | **Five accounts, deliberate partial failure** - one account funded below `min_notional` | Rs 1,000 / Rs 5,000 | 4 filled, 1 skipped **before** send with the right reason; report and UI both correct | Rung 4 |
| 6 | **Twenty accounts** | Customer-set caps | No 429; latency inside `22`'s budget; reconciler keeps up; zero `needs_human` | Rung 5, and the `08` F1 rate-limit experiment |
| 7 | **First external customer** | Their caps | Rung 6 clean for 7 days; runbooks written; kill switch drilled | Rung 6 |

Rung 5 is the most important and the most likely to be skipped. Partial failure is the normal case (`08`), so an untested partial-failure path means the *normal* case is the untested one.

### F7 - Bug classes that cost trading systems money

Each with a specific test, not a general intention.

| Bug class | Targeted test |
|---|---|
| Binary float rounding | `S6` plus a CI grep banning `number` in money types |
| Minor/major unit confusion | Type-level: `Minor<INR>` cannot be assigned to `Major<INR>`; a test asserting a 100x error is a compile error |
| Quantity vs notional confusion | `S1`/`S5` on all 999 markets; a fixture where quantity and notional differ by ~8,000,000 (`BTCINR`) so a swap cannot pass |
| `min_quantity` read without the precision maximum | `S4` against `DOGEINR` specifically |
| `max_quantity` used for a market order | `S4` against `BTCINR` with quantity between 0.0158 and 2 - must be refused |
| Rounding up a buy | `S1` with a budget exactly equal to a step boundary |
| Retry duplication | `I1`, plus the worker-kill simulation |
| Stale price | Preview expiry test; assert an expired preview is rejected server-side |
| Timezone | A test at 23:45 IST asserting the trade lands in the correct IST calendar day and the correct financial year |
| Precision off-by-one | Golden file per market class: 0, 1, 5 and 8 decimal places |
| Sign error on sell | `L5`/`L6` - quantity never negative, cost zero exactly when quantity is zero |
| Fee not reserved | `S1` with a 100%-of-balance buy on both an INR and a C2C market (different holdbacks) |
| TDS netted into P&L | `L7` |
| Conversion counted as a trade | `L8` |
| ms/seconds mixed | `V1`, plus a snapshot test asserting no rendered date is before 2020 |
| Exponent notation leaking to the UI | Snapshot test on a quantity like `0.00000007` |
| Cross-tenant leak | A two-tenant fixture with an access test per resource (`17` F5) |
| Secret in a log | The canary test (`07` F6) |

### F8 - The check-script harness

Mirroring the pattern from the owner's other codebase: standalone Node scripts, runnable individually, printing an assertion count.

```
checks/
  00-money-and-precision.check.js       # money type, formatting, minor units
  00-tenant-isolation.check.js          # cross-tenant access per resource
  00-secret-canary.check.js             # 07 F6 - the sentinel never appears
  01-sizing-999-markets.check.js        # F4, ~200k assertions
  01-market-metadata.check.js           # 999-row fixture parses; absent fields tolerated
  02-signing-golden-vectors.check.js    # HMAC vectors from 06
  03-engine-simulation.check.js         # F5 scenarios, seeded
  03-worker-kill.check.js               # R8
  04-ledger-replay.check.js             # L1-L11 over generated fill sequences
  05-reconciler-loops.check.js          # R1-R10 against the fake exchange
  06-preview-equals-sent.check.js       # U2 end to end
  07-kill-switch.check.js               # asserts no order is sent, per switch level
```

Each prints `PASS <name> — N assertions`. A phase's definition of done cites its check name and its assertion count, so "done" is a command anyone can run rather than a claim.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| A friendly mock hides every real failure | Simulation scenarios that must fail the system | The fake exchange is deliberately hostile (F2) | False confidence, discovered on real money |
| Property tests run on invented markets only | Coverage review | All 999 live rows as fixtures (F4) | The pathological real cases stay untested |
| Rung 5 skipped | Ladder gates are explicit | Numeric pass conditions (F6) | The *normal* case ships untested |
| A rung's cap lives in config | Config review | Caps hard-coded per rung | One edit removes the only bound on loss |
| Simulation is non-deterministic | Flaky failures nobody can reproduce | Seeded fault schedules (F2) | Real bugs dismissed as flakes |
| Kill switch never exercised | A test that asserts no send | F8's `07-kill-switch.check.js` | The switch fails at the moment it is needed |
| Canary test written late | - | It is the first test in the plan | The `16` F1 outcome |
| CI overridden under deadline pressure | Branch protection | No override path exists | The one class of failure this whole document exists to prevent |
| Live probing on write endpoints | Review of what the experiment touches | Only `users/balances` and read endpoints (F1) | Real money spent proving a limit |

## Open questions for Anand

1. **How much real money funds the test account?** Recommended default: **Rs 2,000**, topped up as needed, never more. Rungs 1-5 need roughly Rs 1,500 in total and a bounded loss is the point.
2. **Who signs off each rung?** Recommended default: **one named person, recorded in the plan, with the check-script output attached.** With a two-person team the risk is a rung passed informally in a hurry.
3. **Do we run the rate-limit experiment (`08` F1) before or after rung 1?** Recommended default: **before.** It uses only read endpoints, costs nothing, and its answer changes the reconciler's cadence and the whole capacity model.
4. **Is a second CoinDCX account available for the experiment?** It needs two keys on two accounts from one egress IP. Recommended default: **yes - create one**; without it the per-key-versus-per-IP question cannot be settled and capacity planning stays guesswork.

## Phase hints

- **Phase 00: the canary test, the money property tests, tenant-isolation checks and the CI rules.** All pure, all before any exchange contact.
- **Phase 01: the 999-market sizing suite (F4).** It is the largest single correctness win available and it needs only a captured fixture.
- **The fake exchange is built alongside the adapter, not after it** - the adapter's tests are its first consumer.
- **The worker-kill simulation ships with the engine.** Not one phase later. It is the duplicate-order test.
- **The ladder (F6) is the shape of the real-money phases**: rungs 0-3 are one phase, 4-5 another, 6-7 the go-live gate. Write them into the plan as phases with these exact pass conditions.
- **Every phase's definition of done names a check script and an assertion count**, so completion is verifiable by running one command.

## Sources

- `_sources/coindcx-docs.txt` - searched for `sandbox`, `testnet`, `test net`, `demo account`, `paper trad`: **zero matches** across 14,119 lines, 2026-09-04. Also absent from the FAQ and Setup sections.
- Live fixtures captured 2026-09-04: `markets_details` (999 rows), `ticker`, `candlesticks`, and the latency profile in `17` F1.
- Invariant sources: `08` I1-I10, `09` S1-S10, `10` C1-C6, `11` L1-L11, `12` R1-R10, `13` V1-V8, `14` N1-N8, `21` U1-U10.
- `05-coindcx-websockets.md` - the socket pathologies the fake exchange must reproduce (silent channel accept, silent auth disconnect, stringified `data`, exponent-form numbers).
- `06-coindcx-auth-ratelimits-errors-tos.md` - HMAC golden vectors and error codes for the fake exchange's contract.
- `07-api-key-security.md` F6 - the canary test.
- `16-competitive-benchmark.md` F1 - why the canary test is first: the 3Commas outcome.
- `17-architecture-stack.md` - the pure packages that make F4 possible, and the check-script convention.
