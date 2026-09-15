# Operations runbooks (R1–R8)

Phase-13 T13.8: each runbook is numbered steps, written to be followed at 3 am by
whoever is on call. The full text lives in `research/20-ops-audit-runbook.md` F3
(lines 77–137) — this file indexes them and records the review status so a reader
knows where each scenario lives.

| # | Scenario | Where | Reviewed |
|---|---|---|---|
| R1 | Customer key compromised (external activity, A5) | `research/20` F3 R1 | pending (go-live review) |
| R2 | Our systems compromised | `research/20` F3 R2 | pending |
| R3 | Exchange outage / degradation | `research/20` F3 R3 | pending |
| R4 | Our outage with open orders in flight | `research/20` F3 R4; exercised by the worker-kill scenario (`research/18` F5) and `checks/13-deploy-safety` | pending |
| R5 | Stuck order | `research/20` F3 R5; playbook from `research/12` F8 | pending |
| R6 | Reconciliation mismatch | `research/20` F3 R6 | pending |
| R7 | Bad deploy mid-trade | `research/20` F3 R7 | pending |
| R8 | Customer disputes a fill | `research/20` F3 R8 | pending |

R4's first step — on restart, run the reaper first so a stale lock becomes a
`resolve` job, never a second `place` — is the boot reaper wired in
`apps/api/server.mjs` and proven by `checks/13-deploy-safety`.

**Review rule:** a runbook is "reviewed" only after two people have walked it once
in a dry-run. DoD for Phase 13 records the review as a go-live-gate item (see
`docs/ops/go-live-gates.md`), because a full rehearsal needs the deployed
environment; the repo copy is final text.

## R9 — Running the signer in production

The API will not sign for the real exchange in its own process. Against
`api.coindcx.com` every credential-signed call — placing an order **and** reading a
balance — goes through the signer, because invariant X12 is that no plaintext
credential exists outside it. On a box without it, the API answers:

> `503 refusing to sign for the real exchange in this process: set TRADEX_SIGNER_URL`

**Set up (once):**

```bash
# 1. Generate a shared secret so the signer is not an open decryption oracle.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Add BOTH to the API's .env, plus a STABLE root key:
#      TRADEX_SIGNER_URL=http://127.0.0.1:8098
#      TRADEX_SIGNER_TOKEN=<the hex above>
#      TRADEX_LOCAL_ROOT_KEY=<64 hex — must never change; see the warning below>
```

**Run it** — as a systemd unit, so it comes back after a reboot. A signer that is
down is not a degraded mode: every balance read and every order fails while it is.

```ini
# /etc/systemd/system/tradex-signer.service
[Unit]
Description=Tradex signer
After=network.target postgresql.service

[Service]
User=ec2-user
WorkingDirectory=/home/ec2-user/tradex
EnvironmentFile=/home/ec2-user/tradex/.env
ExecStart=/usr/bin/npm run signer
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now tradex-signer
curl -s localhost:8098/healthz      # {"ok":true,"kms":"local-kms:env"}
```

**Then restart the API.** It reads these at boot; a running process keeps the old
configuration, which is the single most common cause of "I set the variable and
nothing changed".

**Two things to get right:**

* **`TRADEX_LOCAL_ROOT_KEY` must be stable and identical wherever it is used.** The
  API seals credentials at onboarding and the signer opens them — if the two
  processes hold different root keys, nothing decrypts. If the signer holds an
  *ephemeral* one it refuses to start, deliberately: every credential sealed under
  it would be unrecoverable on restart.
* **Run the signer on `127.0.0.1`, never a public interface,** and set
  `TRADEX_SIGNER_TOKEN`. Without the token, anything that can reach the port can
  ask it to sign — the process split would protect nothing.
