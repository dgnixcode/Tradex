# Incident communications templates

Phase-13 T13.9 (research/20, `16` L5): messages are written BEFORE an incident,
and the commitment is a first customer message within **2 hours** of confirming
customer impact. Who sends: the **on-call owner** (the person who engaged the
runbook) drafts and sends; the founder/tech lead approves any message that admits
systemic compromise (R2) before it goes out.

Each message leaves the "we are investigating" slot honest: do not assert the
leak/outage is not ours until it is proven (the 3Commas lesson).

## R1 — Customer key compromised
Subject: Action needed — unusual activity on your API keys
> We detected order activity on your connected exchange account that we did not
> place and cannot attribute to you. We have paused trading on that account.
> Please reply to confirm whether you placed these orders:
> _[fills: time, market, quantity]_
> If you did not place them, please delete the affected API key on the exchange
> now and tell us — we will guide you through connecting a fresh key. We are
> keeping a full record for you.

## R2 — Our systems compromised
Subject: Security notice — action requested
> We are writing to tell you, as a customer whose credentials may have been
> exposed, that we detected a security event. We have stopped trading platform-wide.
> We recommend you delete and re-create any exchange API key you connected to
> Tradex on the exchange side now — that is the only action that fully protects you.
> We will share what we know as we confirm it, without speculation.

## R3 — Exchange outage or degradation
Subject: Exchange status — trading temporarily limited
> The exchange we route through is currently degraded. We have placed trading in
> read-only mode: your open orders are being tracked and may still fill on the
> exchange. We are not cancelling anything automatically. We will post again when
> the exchange recovers.

## R4 — Our outage with open orders in flight
Subject: Status — orders being reconciled after an interruption
> Our platform had an interruption while some of your orders were in flight. We
> have restarted and are resolving those orders against the exchange before
> reopening trading for you. No new orders will be placed for your account until
> every in-flight order is accounted for.

## R5 — Stuck order
Subject: Your order is under review
> One of your orders did not settle to a known state. We are resolving it against
> the exchange. Depending on what it finds we will either confirm the fill or ask
> you to confirm a manual reconciliation. No action needed from you yet.

## R6 — Reconciliation mismatch
Subject: A balance difference on your account
> When we reconciled your account against the exchange we found a difference we
> cannot yet explain. We have marked affected figures as approximate while we
> investigate. Please confirm whether you made any deposits, withdrawals or manual
> trades in this window: _[window]_.

## R7 — Bad deploy mid-trade
Subject: Status — trade plans under review after an update
> During an update, some trade plans may have been created with an older version
> of our sizing rules. We have quarantined any such plan and will re-run the ledger
> checks before trading reopens. No order is at risk.

## R8 — Customer disputes a fill
Subject: Your dispute — here is the full record
> You disputed a fill. Here is the complete chain for your trade: the plan you
> approved, the order we sent, the exchange's response, and the recorded fill.
> If our record matches the exchange, that is the end state. If it does not, we
> will correct it and treat it as a reconciliation incident.

**Commitment:** first customer message within 2 hours of confirmed impact. If an
incident has no customer-facing impact, no message is sent (silence is fine when
nothing was affected); the runbook and an internal note still stand.
