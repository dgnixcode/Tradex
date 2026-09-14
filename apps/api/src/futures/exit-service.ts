// The hard-exit orchestrator — plan/phase-15 T15.7.
//
// "Mid trade, the user can entirely exit even if SL and TP is set" (customer
// requirement). This service enforces the ONLY safe sequence documented in
// research/04 Q(a):
//
//   1. Cancel every UNTRIGGERED conditional order attached to the position.
//   2. Then call `positions/exit`.
//   3. Then read positions back to confirm `active_pos = 0`.
//
// Skipping step 1 is the R1 failure — a stale SL after the exit will fire and
// OPEN AN OPPOSITE POSITION. `checks/15-hard-exit` proves the danger
// synthetically; this service prevents it in production by making step 1
// unskippable.

import type { FuturesMarginCurrency, FuturesPositionSnapshot } from '@tradex/exchange';

/**
 * Who the position belongs to.
 *
 * Every method below needs this, and it is not decoration: signing a venue call
 * means decrypting THAT account's credential, and the port has only venue ids to
 * go on. An earlier version of this interface took bare ids, which made the port
 * impossible to implement — the composition root had no way to know whose
 * credential to ask the signer for, so the Exit button could only ever answer
 * "futures execution is not configured".
 */
export interface FuturesActor {
  readonly tenantId: string;
  readonly accountId: string;
}

export interface FuturesExitPort {
  readonly cancelOrder: (actor: FuturesActor, venueOrderId: string) => Promise<{ ok: boolean; message?: string | undefined }>;
  readonly exitPosition: (actor: FuturesActor, venuePositionId: string) => Promise<{ ok: boolean; venueGroupId?: string | null; message?: string | undefined }>;
  readonly listPositions: (actor: FuturesActor, margin: FuturesMarginCurrency) => Promise<readonly FuturesPositionSnapshot[]>;
  /**
   * Untriggered conditional orders attached to this position. In production the
   * caller sources these from `futures_execution_lock`'s peer table (Phase-15
   * child_order rows with leg_kind in stop_loss/take_profit and trigger_state
   * 'untriggered'); in a test, the FakeVenue's stored orders suffice.
   */
  readonly listUntriggeredConditionals: (actor: FuturesActor, venuePositionId: string) => Promise<readonly { readonly venueOrderId: string }[]>;
}

export interface HardExitRequest {
  readonly actor: FuturesActor;
  readonly venuePositionId: string;
  readonly marginCurrency: FuturesMarginCurrency;
}

export interface HardExitOutcome {
  readonly cancelled: readonly string[];
  readonly cancelFailures: readonly { readonly venueOrderId: string; readonly reason: string }[];
  readonly exited: boolean;
  readonly venueGroupId: string | null;
  /** Final observed activePos — must be '0' for a clean exit. */
  readonly finalActivePos: string;
}

export class HardExitError extends Error {
  override readonly name = 'HardExitError';
  constructor(
    message: string,
    readonly reason: 'exit_refused' | 'cancel_fatal' | 'position_not_flat',
  ) {
    super(message);
  }
}

/**
 * Execute a hard exit under the safe sequence. A cancel that fails on ONE
 * conditional is not automatically fatal — the venue may have already fired
 * it — but we ALSO refuse to call exit if the leg's status is still
 * `untriggered` at the venue (that's what the check re-verifies). The caller
 * (route) surfaces the outcome; a partial cancel gets reported truthfully.
 */
export async function hardExit(port: FuturesExitPort, req: HardExitRequest): Promise<HardExitOutcome> {
  // ---- 1. cancel every conditional attached to the position ----
  const conditionals = await port.listUntriggeredConditionals(req.actor, req.venuePositionId);
  const cancelled: string[] = [];
  const cancelFailures: { venueOrderId: string; reason: string }[] = [];
  for (const c of conditionals) {
    const out = await port.cancelOrder(req.actor, c.venueOrderId);
    if (out.ok) cancelled.push(c.venueOrderId);
    else cancelFailures.push({ venueOrderId: c.venueOrderId, reason: out.message ?? 'unknown' });
  }

  // ---- 2. refuse if a conditional is still untriggered ----
  // The venue's cancel is not idempotent by anything but its own status field,
  // so we re-check by asking for the same list. Anything still there is
  // untriggered — exiting now would leave it live to open an opposite side.
  const stillLive = await port.listUntriggeredConditionals(req.actor, req.venuePositionId);
  if (stillLive.length > 0) {
    throw new HardExitError(
      `refusing to exit while ${stillLive.length} conditional(s) are still untriggered — a stale SL would open an opposite position`,
      'cancel_fatal',
    );
  }

  // ---- 3. exit at market ----
  const exit = await port.exitPosition(req.actor, req.venuePositionId);
  if (!exit.ok) {
    throw new HardExitError(exit.message ?? 'exit refused by venue', 'exit_refused');
  }

  // ---- 4. reconcile to zero ----
  const positions = await port.listPositions(req.actor, req.marginCurrency);
  const p = positions.find((x) => x.venuePositionId === req.venuePositionId);
  const finalActivePos = p?.activePos ?? '0';
  if (finalActivePos !== '0') {
    throw new HardExitError(
      `exit call returned ok but active_pos is still ${finalActivePos}`,
      'position_not_flat',
    );
  }

  return {
    cancelled,
    cancelFailures,
    exited: true,
    venueGroupId: exit.venueGroupId ?? null,
    finalActivePos,
  };
}
