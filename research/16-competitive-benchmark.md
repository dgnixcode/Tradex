# 16 - Competitive and incident benchmark

Status: 2026-09-03 | track: external reality | scope: what comparable products do, and - more usefully - what has already gone catastrophically wrong at one of them, with the engineering lesson from each failure.

**A note on verification.** The incident record in F1 is sourced and quoted. The feature matrix in F3 is drawn from public marketing material and is marked UNVERIFIED throughout: none of these products was signed up for or tested, and vendor feature lists overstate. Treat F3 as a checklist of things to confirm if a competitive claim ever matters commercially, and F1 as the part with real engineering value.

## Verdict

- **The most important fact in this document: in the 3Commas breach, attackers drained accounts through market manipulation, not withdrawals.** Roughly **100,000 API keys** were exposed; a group of traders claimed **~$22 million** in losses; and the drain vector was unauthorised trading on illiquid pairs, using keys that could not withdraw. This is direct, public evidence for the argument in `07`: "the key cannot withdraw" is not a safety property. It is a reason the money leaves more slowly and less traceably, nothing more.
- **3Commas denied the breach before admitting it, and that is what people remember.** Their own FAQ says *"All the information we had available told us it was not coming from us"*; they later confirmed their database was the source. The engineering lesson is about instrumentation, not honesty: they could not tell whether the leak was theirs. If we cannot answer "did this key leak from us?" within hours, we will end up making the same denial in good faith.
- **The other confirmed vector was phishing a lookalike interface.** Attackers stood up sites mimicking 3Commas' UI and harvested keys directly from users. That is not a server-side vulnerability and no amount of envelope encryption prevents it - it is defeated by domain discipline, by never asking for a key anywhere except one canonical page, and by telling customers plainly that we will never ask for their key by email or chat.
- **Feature parity is not where this product wins, and it should not try.** Everything in F3 is table stakes. The differentiators available to Tradex are specific and local: INR-native sizing and reporting, correct handling of the 1% TDS asymmetry that no global tool models (`10` F7), the per-account confirmation preview (`21` F3), and group divergence reporting that no exchange screen can produce (`14` M19).
- **Every competitor in this space carries the same structural weakness we do**, because no exchange offers a truly safe key. Our advantage cannot be "we are secure" - it must be "we are honest about the exposure and we detect abuse fast".

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Security marketing claims | Describe mechanisms, never make absolute claims | 3Commas' breach and denial is the cautionary example; absolute claims age badly | "Bank-grade security", "your keys are safe with us" |
| Key-leak attribution | Build the ability to answer "did this key leak from us?" from day one: per-key fingerprints, decrypt audit, and unknown-activity detection | It is the question we will be asked in an incident, under time pressure | Rely on reasoning after the fact |
| Phishing defence | One canonical add-account page; a stated never-ask policy; no key entry anywhere else, ever | Confirmed vector at 3Commas | Assume server-side security is sufficient |
| Abuse detection | Flag unexpected fills, and weight illiquid-market trades as higher risk | It is the demonstrated drain vector | Watch for withdrawals (there are none to watch) |
| v1 feature scope | Match only what the owner's brief requires; skip bots, DCA, grid, copy-trading, backtesting | Those are separate products, each with their own correctness burden | Match competitor feature lists |
| Differentiators | INR-native reporting, TDS-correct accounting, per-account preview, group divergence | Local, defensible, and downstream of work we are doing anyway | Compete on breadth |

## Findings

### F1 - The 3Commas incident, and what it teaches

Timeline, from the sources listed at the end. VERIFIED as reported; dates and figures as published.

| When | What |
|---|---|
| Oct 2022 | FTX users phished by sites *"mimicking its interface"*; keys and secrets harvested |
| 20 Oct 2022 | 3Commas and FTX alerted to unauthorised trades on **DMG** trading pairs using API keys |
| Oct 2022 | 3Commas' post-mortem: ten users gave enough information to confirm losses tied to the phishing campaign |
| Nov-Dec 2022 | A trader group organising on Telegram claims **~$22 million** stolen via compromised keys |
| Dec 2022 | 3Commas maintains the leak is not theirs: *"All the information we had available told us it was not coming from us"* |
| 28 Dec 2022 | An anonymous Twitter account claims **~100,000 API keys**, publishes **more than 10,000**, threatens the rest |
| Dec 2022 | 3Commas **admits its database was the source** |
| after | Binance publicly cautions users about potential 3Commas key leaks and advises revocation |

The five engineering lessons, each mapped to something in our plan:

| # | Lesson | Where we address it |
|---|---|---|
| L1 | **A no-withdrawal key is not a safe key.** Value was extracted by trading, not withdrawal - reportedly via contra-trades on illiquid pairs, where the attacker's own orders sit on the other side | `07` verdict and T-table; this is why our encryption is the whole defence, not defence in depth |
| L2 | **You must be able to prove where a leak came from.** Without per-key attribution and decrypt auditing, the honest answer is "we don't know", which sounds like a denial | `07` F4 `fingerprint`, F3 decrypt auditing, `20` audit log |
| L3 | **The exchange finds out before you do.** FTX and Binance detected and communicated the anomaly; 3Commas was reacting | `12` Loop C detects fills we did not cause - the earliest signal available to us |
| L4 | **A lookalike UI defeats server-side security entirely.** Users hand over keys voluntarily | One canonical add-account page, a never-ask policy stated in-product, and domain discipline |
| L5 | **Denial compounds the damage.** Repeated denials followed by admission was more reputationally costly than the breach | An incident-comms plan written *before* it is needed (`20`) |

L1 deserves restating because it inverts the standard advice. The industry mantra is "always disable withdrawals on your API key". That advice is correct and insufficient: it stops the fastest drain and leaves the slower one wide open. For CoinDCX specifically, withdrawal is not even offered over the API (`07` F1), so **every** Tradex customer is in exactly the configuration that was drained at 3Commas. The mitigations that actually matter are ours: encryption at rest with a separately-held key, minimal plaintext lifetime, decrypt-rate anomaly detection, and fast detection of trades we did not initiate.

### F2 - How the drain works, and how we would notice

Reconstructed from the reporting; the mechanism is well understood in the market even where specific details are UNVERIFIED.

```
 1. attacker holds victim keys, cannot withdraw
 2. attacker places their own resting orders on an illiquid market at absurd prices
 3. attacker uses victim keys to market-buy/sell into those orders
 4. value transfers from victim to attacker's account, entirely inside the exchange
 5. attacker withdraws from their OWN account, which has full permissions
```

Our detection surface, in order of how quickly it would fire:

| Signal | Source | Latency |
|---|---|---|
| A fill with no matching `client_order_id` | `12` Loop C, `trade_history` sweep | Minutes (sweep cadence) |
| A trade on a market the customer has never traded | same, plus a per-account market allowlist | Minutes |
| Balance delta with no corresponding order | `11` F6 balance reconciliation | Minutes |
| Abnormal decrypt volume for a credential | `07` F3 decrypt auditing | Seconds, if the attack runs through us |
| Customer notices | - | Hours to days |

Two design consequences worth adopting explicitly. First, **a per-account "markets ever traded" set is nearly free and is a high-quality anomaly signal** - a first-ever trade on an illiquid pair is exactly the shape of this attack. Second, the reconciler's unknown-activity alert should be treated as a **security** event, not merely an accounting one, and should be routed accordingly (`20`).

### F3 - Feature matrix (UNVERIFIED)

Compiled from public marketing material only. Not tested. Every cell should be read as "claims to" rather than "does".

| Product | Multi-account | Simultaneous / grouped execution | % of balance sizing | Close-all | Key storage claims | Model |
|---|---|---|---|---|---|---|
| 3Commas | Yes | Yes, across connected exchanges | Yes | Yes | Encrypted at rest (breached 2022 - F1) | Subscription |
| Cryptohopper | Yes | Bot-driven | Yes | Yes | Encrypted at rest | Subscription + marketplace |
| Bitsgap | Yes | Bot-driven | Yes | Yes | Encrypted; publishes security guidance | Subscription |
| Coinrule | Yes | Rule-driven | Yes | Yes | Encrypted | Subscription |
| Altrady | Yes | Multi-account panels | Yes | Yes | Encrypted | Subscription |
| TradeSanta | Yes | Bot-driven | Yes | Yes | Encrypted | Subscription |
| Wunderbit | Yes | Copy + bots | Yes | Yes | Encrypted | Subscription + copy fees |
| HaasOnline | Yes | Script-driven | Yes | Yes | Self-hosted option | Licence |
| Exchange-native copy trading (Binance, Bybit, OKX) | N/A - one account follows a leader | Yes, internal | Proportional | Yes | No keys leave the exchange | Profit share |
| **CoinDCX / India-specific tools** | **None found** in this research | - | - | - | - | - |

Two structural observations that do not depend on the unverified cells:

1. **Exchange-native copy trading is the strongest competitor and the least like us.** It needs no API keys at all, which removes the entire risk class this document is about. Anyone whose requirement is "mirror one strategy across accounts" is better served there. Tradex's requirement is different - *one operator, many accounts they own, deliberate manual trades* - and copy trading does not serve that.
2. **No India-specific or CoinDCX-specific multi-account tool surfaced in this research.** That is either a genuine gap or a signal that the market is small; it is worth deliberately validating before building for scale. It also means no competitor is modelling the 1% TDS asymmetry, INR digit grouping, or the INR-market spread reality - all of which materially affect an Indian customer's returns.

### F4 - What to match, defer, and differentiate on

| Must match at v1 | Why |
|---|---|
| Multi-account connection with named accounts | The brief |
| Groups with simultaneous execution | The brief |
| Percentage and absolute sizing, both sides | The brief |
| Sell-all and close-position | The brief |
| Per-account and per-group P&L | The brief |
| Live charts | The brief |
| Clear partial-failure reporting | Not offered well anywhere; it is the honest way to present a group trade |

| Defer | Why |
|---|---|
| Trading bots, DCA, grid, rule engines | Each is a separate product with its own correctness burden, and none is in the brief |
| Backtesting | Needs historical data infrastructure and invites advisory framing (`15` F6) |
| Copy trading / follower marketplace | Changes the regulatory posture completely - discretion over someone else's money |
| Multi-exchange | The adapter boundary makes it possible later (`15`, `17`); doing it now doubles the correctness surface |
| Mobile app | Responsive web first (`21`) |

| Differentiate on | Why it is defensible |
|---|---|
| **TDS-correct accounting** | The 1% asymmetry between INR and C2C markets changes which venue is cheaper (`10` F7). No global tool models Indian VDA tax |
| **INR-native everything** | Lakh/crore formatting, INR valuation, Indian financial-year reporting (`14`, `21` F6) |
| **The per-account confirmation preview** | Showing exactly what will happen to all 20 accounts, including skips with numbers, *before* sending (`21` F3) |
| **Group divergence reporting** | Best versus worst fill across accounts in one trade, with the reason (`14` M19). No exchange screen can compute it because no exchange knows the accounts are related |
| **Honest failure reporting** | "14 filled, 3 rejected, 2 skipped, 1 needs review" as a normal, well-designed outcome rather than an error state |

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Our database leaks, keys drained by contra-trading | Unknown fills in Loop C; abnormal market for that account | `07` envelope encryption; F2 detection surface; incident comms ready | Every customer, potentially their full balances - the 3Commas outcome |
| We cannot tell whether a leak was ours | - | Per-key `fingerprint`, decrypt audit trail, immutable audit log (L2) | We make an honest denial that turns out wrong |
| Customers phished by a lookalike Tradex | Customer reports; unknown activity | One canonical key-entry page; never-ask policy stated in product; domain discipline | Individual customers, unbounded per customer |
| We claim "secure" and are breached | - | Describe mechanisms, never absolutes | Credibility, permanently |
| We build competitor features and dilute correctness | Scope creep in the plan | F4's defer list, enforced in the phase plan | The correctness guarantees that justify the product |
| Market is smaller than assumed | Commercial validation, not engineering | Validate demand before scaling capacity | Wasted build |

## Open questions for Anand

1. **Has demand been validated?** No India-specific competitor surfaced, which is either the opportunity or the warning. This is the one question in the research set that engineering cannot answer. Recommended: **talk to five prospective customers who each run 5+ CoinDCX accounts before Phase 02** - if they exist, everything else here is worth building.
2. **Do we publish a security page describing our key handling?** It invites scrutiny but it is also the strongest differentiator against a market whose best-known player was breached and initially denied it. Recommended default: **yes, describing mechanisms and the CoinDCX limitation honestly**, with no absolute claims.
3. **Should a first-ever trade on a new market for an account require confirmation?** It is the shape of the contra-trade attack, and the friction is small. Recommended default: **surface it as a notice in the preview** ("this account has not traded XYZINR before"), not a hard block.

## Phase hints

- **The per-account "markets ever traded" set (F2) is a small addition to the account model** (`19`) and should be captured from the first fill, because it is only useful with history behind it.
- **Unknown-activity alerts must be routed as security events**, not accounting anomalies - a one-line requirement in the ops phase (`20`) that determines whether anyone looks at them at 2am.
- **The incident-comms plan (L5) is a go-live gate item.** Writing it after an incident starts is how denials happen.
- **The never-ask policy and canonical key-entry page (L4)** are onboarding-phase requirements, mostly copy and routing.
- Nothing else in this document generates build work. Its value is that it validates `07`'s threat model with public evidence and tells us which features *not* to build.

## Sources

- 3Commas, *API security incident FAQ* - https://3commas.io/blog/api-security-incident-faq - the *"All the information we had available told us it was not coming from us"* statement and the eventual acknowledgement of the intrusion.
- 3Commas, *Lessons from Phishing Incidents* (October 19 post-mortem) - http://3commas.io/blog/october-19-phishing-attack-post-mortem - keys harvested by phishing and *"subsequently used as part of the attack on the exchanges"*; ten users' losses confirmed.
- CoinDesk, 28 Dec 2022 - https://www.coindesk.com/tech/2022/12/28/anonymous-twitter-user-leaks-alleged-3commas-api-database - ~100,000 keys obtained, more than 10,000 published.
- Decrypt - https://decrypt.co/118094/after-repeated-denials-3commas-admits-it-was-source-for-earlier-hacks - repeated denials then admission; the ~$22 million figure claimed by affected traders. Also https://decrypt.co/117826/3commas-api-dispute-highlights-risks-of-algorithmic-trading
- Binance - https://www.binance.com/en/square/post/140518 - the October investigation into unauthorised trades on **DMG** pairs and the public caution to users.
- Blockworks - https://blockworks.co/news/crypto-trading-bot-platform-3commas-rocked-by-critical-api-leak/ - sites *"mimicking its interface"* used to harvest keys.
- Bitsgap security guidance - https://bitsgap.com/blog/is-it-safe-to-connect-your-exchange-api-to-a-trading-bot - *"attackers drained accounts through market manipulation, not withdrawals — proof that a no-withdrawal key alone isn't enough"*, which is the single most useful sentence found in this research.
- The Cyberwire - https://thecyberwire.com/stories/a666c87c98da44d6ae7bba10afba84d1/3commas-api-compromised ; Wu Blockchain's process review - https://wublock.substack.com/p/review-of-the-whole-process3commas
- F3 feature matrix: public marketing pages of the named products only. **UNVERIFIED** - no product was signed up for or tested.
- Cross-references: `07-api-key-security.md` (threat model, `fingerprint`, decrypt auditing - all validated by F1), `10-multi-currency-inr-usdt.md` F7 (the TDS differentiator), `11`/`12` (detection surface), `14-analytics-product-spec.md` M19 (group divergence), `15-india-regulatory-compliance.md` (why copy trading changes the regulatory posture), `19-accounts-groups-data-model.md` (markets-ever-traded set), `20-ops-audit-runbook.md` (incident comms, security routing), `21-frontend-ux-spec.md` (canonical key-entry page).
