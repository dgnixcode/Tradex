// The resolve ladder — plan/phase-06 T06.6, from 12 F3.
//
// After an AMBIGUOUS send (the response was lost; the order may or may not have
// landed) the only safe move is to ASK the venue, repeatedly, at widening
// intervals, until the outcome is known. This models that decision as a pure,
// deterministic function — the schedule is injected as a list of gaps, so the
// logic is testable without sleeping for 32 seconds.
//
// The subtle rule it encodes is the one that prevents a FALSE NEGATIVE:
// "A first not-found within 2 s of send is retried, not trusted." The venue's
// order store can lag the create by a moment; if we trusted a not-found a second
// after a lost response, we would conclude "never landed" and a duplicate send
// could place a SECOND order. Only a not-found AFTER the trust delay is believed.
//
// Exhausting the schedule with no answer is `needs_human`: the child is frozen and
// an alarm raised (the phase doc) rather than guessed at.

export interface LadderResolve {
  (coid: string): Promise<
    { readonly ok: true; readonly order: { readonly id: string; readonly statusRaw: string } | null }
    | { readonly ok: false }
  >;
}

export type LadderOutcome =
  | { readonly state: 'placed'; readonly exchangeOrderId: string; readonly statusRaw: string }
  | { readonly state: 'not_found' }
  | { readonly state: 'needs_human' };

export interface ResolveLadderOptions {
  /** Gaps between resolve attempts, ms, in order. Defaults to 12 F3's 250/1s/3s/8s/20s. */
  readonly stepGapsMs?: readonly number[] | undefined;
  /** A not-found before this much time since the first attempt is NOT trusted. */
  readonly notFoundTrustDelayMs?: number | undefined;
}

const DEFAULT_GAPS: readonly number[] = [250, 1_000, 3_000, 8_000, 20_000];
const DEFAULT_TRUST_DELAY = 2_000;

/**
 * Resolve an ambiguous order by walking the ladder. Deterministic: `elapsed` is
 * the running sum of the injected gaps, so identical inputs (including schedule)
 * give identical behaviour in a test and in production.
 */
export async function resolveLadder(
  coid: string,
  resolve: LadderResolve,
  opts: ResolveLadderOptions = {},
): Promise<LadderOutcome> {
  const gaps = opts.stepGapsMs ?? DEFAULT_GAPS;
  const trustDelay = opts.notFoundTrustDelayMs ?? DEFAULT_TRUST_DELAY;
  let elapsed = 0;

  for (const gap of gaps) {
    elapsed += gap;
    const r = await resolve(coid);
    if (!r.ok) continue; // the venue itself erred; keep trying the next rung
    if (r.order !== null) {
      return { state: 'placed', exchangeOrderId: r.order.id, statusRaw: r.order.statusRaw };
    }
    // A not-found only becomes trustworthy once we are past the trust delay.
    if (elapsed > trustDelay) return { state: 'not_found' };
  }
  return { state: 'needs_human' };
}
