# 15 - India regulatory and platform-rules surface

Status: 2026-09-03 | track: external reality | scope: the CoinDCX API Terms that govern whether this product may exist at all, plus the Indian tax, anti-money-laundering, advisory, data-protection and GST surface around it.

**This is research, not legal advice.** Every finding below is sourced and quoted so that a lawyer can verify it quickly. The lawyer checklist at the end is not a formality - three items in it can change the shape of the product.

## Verdict

- **One clause in CoinDCX's own API Terms is a direct threat to the product as specified, and it is not the one anyone expects.** Clause 2.3(c): *"The User shall not redistribute, display, or disseminate the Market Data or any data, charts, analytics, research, or other works based on, referring to, or derived from the Market Data to any third party."* Tradex's charts, prices, spread warnings, previews and P&L analytics are all works derived from CoinDCX Market Data, displayed to our customers. If our customers are "third parties" under that clause, the core UI is prohibited. **Get this clarified in writing before building the charting and analytics phases.**
- **The licence is explicitly non-sublicensable, and CoinDCX can terminate it without notice or reason.** Clause 2.1 grants a *"non-exclusive, non-transferable, non-assignable, non-sublicensable, revocable, restricted license"*; clause 5.2 lets CoinDCX terminate *"without any notice … and without assigning any reason"*, with the user waiving all rights to claim. That is existential platform risk with no contractual protection whatsoever, and it is the strongest argument for keeping the exchange behind an adapter boundary from day one.
- **CoinDCX's total liability to us is capped at Rs 1,00,000, and we indemnify them.** Clause 9 caps aggregate liability at one lakh rupees; clause 10 makes us indemnify CoinDCX for anything arising from our use of the API - including, on its face, claims brought by our own customers. So if an exchange defect costs a customer Rs 50 lakh, our recovery is capped at Rs 1 lakh and we carry the rest. This must be reflected in our own customer terms and priced into the business.
- **Clause 7 disclaims exactly the property the owner asked for.** In capitals: CoinDCX *"DOES NOT WARRANT THAT THE COINDCX API … WILL BE SAFE, UNINTERRUPTED, ERROR FREE"*. The upstream explicitly refuses to be error-free. That settles the "100% error free" question at the boundary: it is unachievable by construction, and the five properties in the brief's honesty requirement are what we can actually promise.
- **Assume Tradex is a PMLA reporting entity. The trigger is not custody.** Notification S.O. 1072(E) of 7 March 2023 covers five activities carried out *"for or on behalf of another natural or legal person in the course of business"*, and the fourth is *"safekeeping or administration of VDAs **or instruments enabling control over VDAs**"*. An API key is precisely an instrument enabling control over VDAs, and we store and administer it on our customers' behalf as our business. A third activity, *"transfer of VDAs"*, arguably also applies since we initiate transfers on instruction. Being non-custodial does not exempt us. Enforcement is real: as of March 2026 the Ministry of Finance told the Lok Sabha that 54 VDA SPs were registered and FIU-IND had directed takedown of apps and URLs of **53 non-compliant** providers.
- **The tax regime is unchanged and hostile: 30% flat plus 4% cess, 1% TDS, no loss set-off.** Sections 115BBH and 194S survive into the Income-tax Act, 2025 and Budget 2026 left them alone. Practical consequence for the product: customers need per-financial-year realised gains and TDS totals, and every extra round trip costs them 1-2% in withheld capital (`11` F4, `10` F7).
- **Never give trading advice, and structure the product so we cannot be read as doing so.** No signals, no suggested trades, no "recommended" percentages, no default group strategies. The customer chooses; we execute. That posture is also what keeps us clear of investment-adviser regulation, and it costs nothing because the owner did not ask for signals.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| CoinDCX Terms clause 2.3(c) | **Blocking question. Obtain written clarification or permission before the charting/analytics phases** | Our entire UI displays derived Market Data to customers | Assume customers are not third parties and build anyway |
| Exchange abstraction | Adapter boundary from day one, even with one exchange | Clause 5.2 allows termination without notice or reason | Couple directly to CoinDCX and abstract later |
| Our customer terms | Mirror CoinDCX's disclaimers, cap our liability, disclose the Rs 1 lakh upstream cap explicitly | We cannot promise more than our supplier gives us | Silent on upstream limits |
| "100% error free" in marketing | **Never claim it.** Publish the five achievable properties instead | Clause 7 makes the claim false, and a false claim in a money product is a legal exposure of its own | Market it as error-free |
| PMLA posture | **Assume in scope.** Build KYC-capable, 5-year-retention, STR-capable foundations; take legal advice on registration before launch | Activity (iv) reads directly onto what we do; the downside of being wrong is app takedown | Assume non-custodial means out of scope |
| Record retention | **5 years minimum**, for both API usage records and customer identity records | CoinDCX clause 6.6 requires 5 years post-termination; PMLA independently requires 5 years | A shorter default |
| Advisory posture | Pure execution. No signals, no recommendations, no curated strategies | Avoids investment-adviser exposure entirely, at zero product cost | Add "suggested allocations" as a feature |
| Algorithmic-trading warranty | Record that we have reviewed clause 6.4 and hold whatever consents apply; raise with counsel | Clause 6.4 makes us warrant we hold *"the relevant licenses to conduct any … Algorithmic Trading"*, and clause 1.4's definition covers exactly what we do | Ignore it as boilerplate |
| Data protection | Consent notice at signup, purpose limitation, breach process, India-resident storage | DPDP Act 2023 applies to the personal data we hold | Defer to post-launch |
| Tax reporting features | CSV of fills, fees and TDS per Indian financial year in v1 | Cheap; the regime makes it necessary | None, or a formatted report |
| GST | Charge GST on subscription fees; take a CA's advice on rate and registration thresholds | We are selling a service in India | Ignore until revenue appears |

## Findings

### F1 - The CoinDCX API Terms, clause by clause

Read in full from the docs dump. The Terms govern *"the use of any 'Market Data' and Application Programming Interface (API) of CoinDCX"* and bind the user *"upon accessing"* - there is no separate signature step. Counterparties named: **Primestack Pte. Limited** and **Neblio Technologies Private Limited**.

| Clause | What it says | Impact on Tradex |
|---|---|---|
| 1.4 | *"Algorithmic Trading … means a method which uses a computer program following a defined set of instructions or algorithm to place a trade"* | This is a literal description of Tradex |
| 1.11 | HFT defined as algorithmic trading with high speed and order-to-trade ratios | We are not HFT; useful to be able to say so |
| **2.1** | Licence is *"non-exclusive, non-transferable, non-assignable, non-sublicensable, revocable, restricted"* | We cannot pass API access through to customers as our own service. Each customer must be their own licensee via their own key |
| 2.3(a) | No altering, manipulating or misrepresenting Market Data | Our derived numbers must be traceable to source values |
| 2.3(b) | No reverse engineering | Fine |
| **2.3(c)** | No redistributing, displaying or disseminating Market Data **or derived works** to any third party | **See F2 - the central problem** |
| 2.3(d) | Affiliate use must be disclosed and *"may involve additional pricing"* | Affiliate means >50% control, so customers are not affiliates |
| 3.1 | No fees *presently*, but CoinDCX reserves the right to charge | Our unit economics can be changed unilaterally |
| 4.2 | We may not *"delete, remove, alter, hide, move"* CoinDCX IP | Attribution of data source may be required in the UI |
| **5.2** | Termination *"without any notice … and without assigning any reason"*; user *"waives any and all rights to claim"* | Existential risk, no notice period, no remedy |
| 5.3 | Immediate termination for IP breach, terms breach, or *"fraudulent, illegal, immoral, or any activity not authorized by CoinDCX"* | "Not authorized by CoinDCX" is open-ended and includes, potentially, F2 |
| **6.4** | We warrant we hold *"the relevant licenses to conduct any High Frequency Trading or Algorithmic Trading"* | A warranty about a licence regime that may not exist for crypto in India - counsel must advise |
| **6.6** | We must *"preserve and maintain the information, data and relevant records pertaining to the use of the CoinDCX API/ Market Data for a period of 5 years post termination"* | A concrete, cheap, mandatory retention floor - now the basis for `20`'s retention policy |
| 6.7 | CoinDCX is not an advisor or fiduciary; we are solely responsible for our decisions and our legal compliance | We cannot point upstream when something goes wrong |
| **7** | *"AS IS"*, *"AS AVAILABLE"*, *"DOES NOT WARRANT … SAFE, UNINTERRUPTED, ERROR FREE"* | Directly answers the brief's "100% error free" |
| 8 | We must protect PII received through the API, employ reasonable security, and report intrusions to CoinDCX | An affirmative security obligation, on top of DPDP |
| **9** | Aggregate liability capped at **Rs 1,00,000** | Our maximum recovery for an exchange-caused loss |
| **10** | We indemnify CoinDCX for claims arising from our use of the API, breach, or fraudulent use | Customer claims may land on us and only on us |
| 11-12 | Arbitration seated in **Mumbai**, Indian law, Mumbai courts exclusive | Dispute venue is fixed and local |
| 13.1 | No assignment to third parties without consent | Relevant to any future sale of the business |
| 13.5 | No principal-agent relationship | We may not present ourselves as acting for CoinDCX |

### F2 - Clause 2.3(c): the Market Data redistribution problem

The clause, verbatim:

> *"The User shall not redistribute, display, or disseminate the Market Data or any data, charts, analytics, research, or other works based on, referring to, or derived from the Market Data to any third party."*

And "Market Data" is defined expansively as *"all data related to the trading activity on any website, applications or platform owned and operated by"* CoinDCX, *"including … the prices and quantities of orders and transactions executed on any platform/ application of CoinDCX."*

What Tradex does that falls inside that definition:

| Feature | Derived from Market Data? |
|---|---|
| Price chart (`13`) | Yes - candles are Market Data |
| Depth panel and trade tape | Yes |
| Spread warning and round-trip cost estimate (`21` F2) | Yes - computed from the book |
| Confirmation preview showing the best ask and computed cost (`21` F3) | Yes |
| Unrealised P&L and equity curves (`14`) | Yes - marked to Market Data prices |
| Order status and our own fills | **No** - that is the customer's own account data, not Market Data |

So the customer's own trading records are safe; almost everything else in the UI is derived from Market Data.

Two readings, both arguable, and the difference decides whether the product can ship as specified:

| Reading | Argument | Consequence |
|---|---|---|
| **Customers are not third parties** | Each customer holds their own CoinDCX account and their own API key, has themselves accepted these Terms as a "User", and we merely render their own licensed data back to them on their instruction | The UI is fine. Tradex is a tool the customer operates, not a redistributor |
| **Customers are third parties** | We are a distinct legal entity that fetches Market Data under our own access to public endpoints and displays it in our product to people who are not us | Charts, depth, spread warnings and mark-to-market P&L are all prohibited without permission |

The second reading is not far-fetched: our server pulls `public.coindcx.com` candles with no customer key involved, so that data is fetched under *our* access and displayed in *our* product. The first reading is the one the market plainly operates on - several products described in `16-competitive-benchmark.md` do exactly this - but "everyone does it" is not a defence, and clause 5.3(c) lets CoinDCX terminate for *"any activity not authorized by CoinDCX"*.

**Recommended action, in order:** (1) counsel reviews the clause; (2) we write to CoinDCX describing precisely what we display and to whom, and ask for written confirmation or a data-licence arrangement; (3) meanwhile, sequence the build so charting and analytics are not the first phases, and keep a fallback design in which per-account market data is fetched using **that customer's own key** wherever an authenticated equivalent exists. Note that the fallback is only partial: candles and depth come from public endpoints that take no key at all.

### F3 - Does operating other people's keys differ from operating your own?

This is the crux of the business model, and the Terms do not address it directly. What they do say:

| Fact | Source |
|---|---|
| The licence is non-sublicensable and non-transferable | 2.1 |
| "User" includes *"an individual, association of persons, company, or any legal entity and its respective affiliates"* | preamble |
| Affiliates are >50%-control relationships and must be disclosed, with possible extra pricing | 1.1, 2.3(d) |
| No principal-agent relationship exists between us and CoinDCX | 13.5 |
| Sub-accounts exist as a CoinDCX feature, with separate keys per sub-account | FAQ (`01`) |
| Keys are interchangeable and unrestricted; a user may hold unlimited keys | FAQ (`07` F1) |
| IP-bound keys *"cannot be shared with any other user having different IP"*, and CoinDCX notes you *"might need to create a different API key for every user"* | help pages, FAQ |

That last row is quietly the most useful: CoinDCX's own FAQ contemplates a scenario with **multiple users of keys**, and advises creating a key per user. It does not read like a prohibition on third-party tools.

The honest position: nothing in the Terms forbids a customer from using software to operate their own account, and the customer remains the licensee for their own key. What is untested is (a) whether *we* additionally need our own arrangement given clause 2.3(c), and (b) whether operating many customers' keys commercially attracts the *"scale of use, type of entity"* pricing contemplated in clause 3.2. Both are questions to put to CoinDCX in writing rather than to resolve by inference.

### F4 - Tax: 30% + 4% cess, 1% TDS, no set-off

| Item | Position | Source |
|---|---|---|
| Rate on income from transfer of a VDA | **30% flat**, plus 4% cess (effective ~31.2%) | s.115BBH, Income-tax Act 1961; retained in the Income-tax Act, 2025 |
| Deductions allowed | **Cost of acquisition only.** No expenses, no allowances | s.115BBH |
| Loss set-off | **None** - not against other income, not against other VDA gains, no carry-forward | s.115BBH |
| TDS | **1%** on consideration for transfer of a VDA | s.194S |
| Holding period | Irrelevant - no short/long-term distinction | s.115BBH |
| Budget 2026 | **No change**; the Budget speech did not mention VDAs | press reporting, F-sources |
| Who deducts on CoinDCX | CoinDCX deducts and remits on the customer's behalf; certificate available in-app | `11` F4 |

Product consequences, all already reflected elsewhere: TDS is a separate ledger line and never nets into P&L (`11`); it is asymmetric between INR and C2C markets and changes market preference (`10` F7); customers need per-financial-year totals (`14`); and the no-set-off rule means a customer's *gross* winning trades are taxed even in a losing year, which makes fee and spread discipline unusually valuable to them.

One thing we must **not** do: present any of this as tax advice or compute a customer's tax liability. We report what we observed - fills, fees, estimated TDS - and point at their CoinDCX statement.

### F5 - PMLA and FIU-IND

Notification **S.O. 1072(E) dated 7 March 2023** brought VDA activities into the PMLA reporting-entity net. The five notified activities, applying when *"carried out for or on behalf of another natural or legal person in the course of business"*:

| # | Activity | Applies to Tradex? |
|---|---|---|
| 1 | *"exchange between VDAs and fiat currencies"* | We initiate them on instruction; the exchange performs them |
| 2 | *"exchange between one or more forms of VDAs"* | Same - and our conversion feature is exactly this (`10` F5) |
| 3 | *"transfer of VDAs"* | Arguably yes: every trade we place is a transfer, initiated by us on the customer's behalf |
| 4 | *"safekeeping or administration of VDAs **or instruments enabling control over VDAs**"* | **Yes, on a plain reading.** An API key is an instrument enabling control over VDAs. We store, encrypt and administer it, for another person, as our business |
| 5 | *"participation in, or provision of financial services related to, an issuer's offer and sale of a VDA"* | No |

Activity 4 is the one that matters and it does not turn on custody. Non-custodial status is not an exemption, because custody is only one of five triggers.

Obligations if in scope:

| Obligation | Detail |
|---|---|
| Registration | Enrol with FIU-IND as a reporting entity; disclose bank/FI accounts. **Registration is not a licence** and FIU-IND does not publish the registered list |
| Governance | Named **designated director** and **principal officer**; AML/CFT/CPF programme; staff training; internal audit |
| KYC | Client and beneficial-owner identification, CDD and EDD |
| Records | Enough to reconstruct individual transactions; **5-year retention** for transaction and identity records |
| Reporting | Monthly transaction information to the Director; **STRs** promptly, with confidentiality |
| Travel Rule | Originator and beneficiary details on transfers; unhosted-wallet transfers treated as high risk |
| Enforcement | PMLA s.13: warnings, directions, monetary penalties |
| Extraterritorial | Applies to offshore platforms serving Indian users |

Timeline and enforcement reality: original guidelines effective 10 March 2023; third revised registration circular 15 September 2025; **updated AML/CFT guidelines listed 8 January 2026**. As of 9 March 2026, per a Ministry of Finance answer to Lok Sabha Unstarred Question 5805, **54 VDA SPs were registered and FIU-IND had directed takedown of apps and URLs of 53 non-compliant providers**. Nine offshore show-cause notices were issued in December 2023 and 25 more in October 2025.

The practical reading: this is an actively enforced regime with a demonstrated willingness to remove non-compliant products from app stores and the internet. **Design as though we are in scope** - the incremental cost during the build is small (KYC-capable customer model, 5-year retention, an audit trail that can reconstruct transactions, a principal-officer role) and the cost of retrofitting under a takedown notice is the business.

### F6 - Investment advice and SEBI

VDAs are not securities under Indian law, so SEBI's investment-adviser regulations do not obviously bite. But the exposure is not zero and it is entirely avoidable, so the correct engineering answer is to make the question moot:

| Do | Do not |
|---|---|
| Execute exactly what the customer selects | Suggest a coin, a side, a size or a time |
| Show measured facts (spread, round-trip cost, minimum sizes) | Label anything "recommended", "optimal" or "suggested" |
| Let the customer name and define their own groups | Ship pre-built "strategy" groups |
| Report what happened | Project what will happen |
| Default numeric fields to empty | Default a percentage to a value that implies endorsement |

The last row is subtler than it looks: pre-filling "20%" in the sizing field is a small nudge that a regulator or a litigant could characterise as a recommendation. Leave it empty. Costs nothing.

UNVERIFIED and worth a lawyer's view: whether operating trades on many clients' accounts on their instruction could be characterised as portfolio management. The distinguishing features in our favour are that we hold no discretion whatsoever, take no performance fee, and never initiate a trade. Preserving all three is a product constraint, not just a legal one - the moment Tradex gains discretion, this section changes completely.

### F7 - Data protection (DPDP Act 2023)

We hold names, emails, phone numbers, and encrypted exchange credentials - personal data of identifiable individuals, processed in India.

| Obligation | What it means here |
|---|---|
| Notice and consent | Plain-language notice at signup stating what we collect, why, and for how long |
| Purpose limitation | Credentials are used to execute the customer's instructions and nothing else. No analytics on their trading for our own purposes without separate consent |
| Data minimisation | We already refuse to store passwords and 2FA seeds (`07` F10). Do not collect a date of birth or address unless KYC requires it |
| Security safeguards | Envelope encryption, access control and audit as specified in `07` |
| Breach notification | A defined process and a defined timeline, owned by `20-ops-audit-runbook.md` |
| Rights | Access, correction and erasure requests - and erasure interacts with our 5-year retention duty (F1 clause 6.6, F5 PMLA), which generally overrides |
| Retention | 5 years, driven by the stricter of the two obligations above, disclosed in the notice |

The erasure-versus-retention tension is a real one and must be resolved in the privacy notice rather than discovered when the first deletion request arrives: transaction and identity records are retained for the statutory period even after account closure, while credentials are crypto-shredded immediately (`07` F7).

UNVERIFIED: the commencement status of specific DPDP rules and any Significant Data Fiduciary designation thresholds. Confirm with counsel; nothing in the engineering plan changes on the answer.

### F8 - GST

We sell a subscription service to Indian customers. Standard GST on services applies; registration thresholds and place-of-supply rules are a CA question, not an engineering one. Two things the build must support regardless: GST-compliant invoices with our GSTIN and the customer's, and the ability to record a customer's GSTIN at signup. Note that GST on *our* fee is separate from the trading fees and TDS the exchange charges, and the three must never appear in one merged number.

## Design

### The defensible posture, stated as product constraints

| Constraint | Enforced by |
|---|---|
| We never hold customer funds or crypto | Architecture: keys only, no wallets (`17`) |
| We never have trading discretion | Product: no automation that initiates a trade without a customer action |
| We never advise | Product: no signals, no recommendations, no pre-filled sizing (F6) |
| We can identify every customer | KYC-capable customer model (`19`) |
| We can reconstruct any transaction for 5 years | Append-only ledger and audit log with 5-year retention (`11`, `20`) |
| We can produce a suspicious-activity report | Audit trail plus a named principal officer |
| We can survive losing CoinDCX | Exchange adapter boundary from day one |
| We never claim error-freeness | The five properties from the brief, published as our actual guarantees |

### Consents and disclosures the onboarding flow needs

| Where | Content |
|---|---|
| Signup | DPDP notice; terms of service including our liability cap and the Rs 1 lakh upstream cap; retention period |
| Add account | The CoinDCX key-permission disclosure (`21` F5) - no restricted keys exist, keys can trade and move funds between the customer's own wallets, cannot withdraw externally; the IP-binding warning |
| Add account | Explicit acknowledgement that the customer authorises us to place orders on that account on their instruction |
| First group trade | Acknowledgement that group trades are per-account independent and partial failure is normal |
| Trade ticket | No advice, no recommendation - a factual spread and cost warning only |
| P&L screens | "Not tax advice"; TDS figures are estimates; link to the customer's CoinDCX statement |

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Clause 2.3(c) enforced against us | A notice from CoinDCX, or termination under 5.3(c) | Written clarification obtained before the charting phase (F2) | Charts, depth, spread warnings and mark-to-market P&L all removed - or the product terminated |
| CoinDCX terminates without notice (5.2) | API access stops working for every customer at once | Adapter boundary; a second exchange researched in advance; a customer comms plan ready | Total loss of service, no notice, no remedy |
| We are a PMLA reporting entity and did not register | An FIU-IND notice, or an app/URL takedown direction | Assume in scope, build compliant foundations, take advice before launch | The business - 53 providers have already been directed for takedown |
| A customer claim exceeds Rs 1 lakh of upstream recovery | A dispute | Our own liability cap, professional indemnity insurance, and honest disclosure of the upstream cap | Our balance sheet |
| We are read as giving advice | A complaint or a regulatory query | F6's constraints, enforced in the product | Regulatory exposure and a forced product change |
| Retention shorter than 5 years | An audit request we cannot satisfy | 5-year floor set in the schema from day one (`19`, `20`) | Breach of clause 6.6 and of PMLA |
| Erasure request conflicts with retention | A DPDP request | Documented in the privacy notice; credentials shredded, records retained | Reputational, if handled badly |
| "100% error free" appears in marketing | Review of copy | Publish the five properties instead | A false-claim exposure on top of the operational one |
| Tax figures presented as authoritative | Customer relies on our number and is wrong | Label estimates; point at the CoinDCX certificate (`11`) | Trust, and possibly liability |

## Open questions for Anand

These are the ones a lawyer or CoinDCX must answer, not ones I can decide.

1. **Clause 2.3(c) - may we display Market Data and derived analytics to our customers?** This is the single blocking question in the whole research set. Recommended action: **counsel review plus a written request to CoinDCX describing exactly what we display**, before the charting phase starts. Do not let the answer arrive after the UI is built.
2. **Are we a PMLA reporting entity, and must we register with FIU-IND before launch?** Recommended default: **assume yes and build for it.** The engineering cost now is small; the cost of being wrong is a takedown direction.
3. **Clause 6.4 - what "relevant licenses" for Algorithmic Trading are we warranting we hold?** Possibly none exist for crypto in India, in which case the warranty is satisfied vacuously - but that needs to be counsel's conclusion, in writing, not ours.
4. **Do we need our own commercial arrangement with CoinDCX given clause 3.2's "scale of use, type of entity" language?** Approaching them proactively also opens the HFT trusted-IP route (`07` F1) that would solve both the IP-allowlist and rate-limit problems. Recommended default: **open the conversation early**, treating any outcome as upside.
5. **What liability cap do we put in our own customer terms, and do we buy professional indemnity cover?** Given a Rs 1 lakh upstream cap and a full indemnity flowing the other way, this is a commercial decision that should be made before the first real-money customer.

## Phase hints

- **Phase 00 must set the 5-year retention floor** in every schema that holds a transaction or an identity record. Retrofitting retention is easy; retrofitting *records we never kept* is impossible.
- The **KYC-capable customer model** belongs in the identity phase (`19`) even if KYC is not collected at launch: fields, verification states and an audit trail, so registration does not require a migration.
- **Charting and analytics phases must be gated on open question 1.** Sequence them after the execution core regardless - which is what `13` and `14` already recommend for other reasons, so the gate costs nothing.
- The **exchange adapter boundary** is a Phase 00/01 decision driven by clause 5.2, not a nice-to-have abstraction.
- **Customer terms, privacy notice and the three onboarding acknowledgements** are a go-live gate item, not a backlog item.
- A **principal officer and designated director** are named roles, not code - but the audit log must be able to support what they are required to report, which is a schema decision made early.

## Lawyer checklist

Three items can change the product; the rest are confirmations.

| # | Question | Can change the product? |
|---|---|---|
| 1 | Does clause 2.3(c) prohibit displaying Market Data and derived analytics to our customers? | **Yes - could remove the entire chart and analytics surface** |
| 2 | Is Tradex a reporting entity under S.O. 1072(E), specifically activity (iv)? Must we register with FIU-IND before launch? | **Yes - registration, KYC and STR obligations** |
| 3 | Could operating trades on many clients' accounts be characterised as portfolio management or investment advice? | **Yes - would constrain features permanently** |
| 4 | What licences does clause 6.4's Algorithmic Trading warranty require in India? | No, if the answer is none |
| 5 | Is the clause 10 indemnity enforceable against us for our own customers' claims? | No, but it prices our insurance |
| 6 | What liability cap and disclaimers should our customer terms carry, given the Rs 1 lakh upstream cap? | No |
| 7 | DPDP: consent notice wording, retention-versus-erasure, any Significant Data Fiduciary threshold | No |
| 8 | GST: rate, registration threshold, place of supply, invoice requirements | No |
| 9 | Do we need a written data or commercial arrangement with CoinDCX (clauses 2.3(c), 3.2)? | Possibly - it may be the answer to item 1 |

## Sources

- `_sources/coindcx-docs.txt` lines **396-538** - the complete CoinDCX API Licence Terms and Conditions, clauses 1 to 13, quoted verbatim in F1 and F2. Counterparties: Primestack Pte. Limited and Neblio Technologies Private Limited. Arbitration and jurisdiction: Mumbai, India.
- `_sources/coindcx-docs.txt` FAQ - unlimited keys, no read-only APIs, keys interchangeable, IP-bound keys not shareable across users with a different IP, separate keys for master and sub-accounts.
- Ministry of Finance Notification **S.O. 1072(E)**, 7 March 2023 - the five notified VDA activities, as summarised at https://cryptoslate.com/crypto-laws/india-pmla-vda-service-provider-aml-cft-regime/ (secondary source; the gazette text should be read by counsel).
- FIU-IND - AML/CFT Guidelines for Reporting Entities Providing Services Related to Virtual Digital Assets, original effective 10 March 2023, **updated version listed as of 8 January 2026**; third revised registration circular 15 September 2025. Index: https://fiuindia.gov.in/files/Downloads/Downloads.html
- Ministry of Finance answer to Lok Sabha **Unstarred Question 5805** - 54 registered VDA SPs and takedown directions against 53 non-compliant providers as of 9 March 2026: https://sansad.in/getFile/loksabhaquestions/annex/187/AU5805_lMTYNK.pdf?source=pqals
- Income Tax Department on s.194S - https://www.incometaxindia.gov.in/w/tds-on-payment-for-the-transfer-of-virtual-digital-assets-vdas-
- Sections 115BBH and 194S retained in the Income-tax Act, 2025 - https://help.myitreturn.com/hc/en-us/articles/61539362797849-Crypto-Tax-under-Income-tax-Act-2025-Tax-Rate-TDS-Losses-and-VDA-Rules-Explained ; 30% plus 4% cess and the no-set-off rule - https://www.koinx.com/in/tax-guides/crypto-tax-guide-for-accountants/ ; Budget 2026 left the regime unchanged - https://coincentral.com/indias-30-crypto-tax-stays-put-what-budget-2026-means-for-investors/
- `11-positions-ledger-pnl.md` F4 - CoinDCX's own TDS applicability table and worked examples.
- Cross-references: `07-api-key-security.md` (key permissions, HFT trusted IP), `10-multi-currency-inr-usdt.md` F7 (TDS asymmetry), `13`/`14` (the surfaces gated by F2), `17-architecture-stack.md` (adapter boundary), `19-accounts-groups-data-model.md` (KYC-capable model), `20-ops-audit-runbook.md` (retention, breach process, STR support), `21-frontend-ux-spec.md` F5 (disclosures).


