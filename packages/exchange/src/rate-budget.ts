// Rate budget — plan/phase-01 T01.6, from 06 F6 and 22 F3.
//
// Four published rate-limit figures for CoinDCX disagree by 50x: 2000/60s per
// route, "16/sec, 960/min" in the FAQ, 100/min on the help site, and a live
// `ratelimit-policy: 5000;w=60` header. 06 F6's rule is the one implemented
// here: seed at the tightest published number, drive closed-loop off the
// response headers, and never widen against a document.
//
// Two scopes are metered because gate G2 is still open — nobody has measured
// whether the limit is per key or per egress IP (T01.5). Metering both is the
// only configuration that is correct under either answer, and the cost of being
// wrong in this direction is latency; the cost of being wrong in the other is a
// 429 in the middle of a fan-out, which leaves some accounts filled and some not.
//
// The meter is GCRA, held as a single timestamp per scope rather than a token
// count. That is deliberate: a float token count drifts as it is refilled, and
// one timestamp is exactly what a Redis-backed implementation can update
// atomically, so moving off the in-memory store is a store swap and not a
// rewrite of the algorithm.

/** Injected so a test can drive time instead of waiting for it. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
};

export class RateBudgetError extends Error {
  override readonly name = 'RateBudgetError';
}

/**
 * One meter's shape. `burst` is how many requests may go out back-to-back; the
 * sustained rate is `count` per `perMs`. A 20-account fan-out needs a burst of
 * at least 20 to go out promptly, which is why burst is separate from rate.
 */
export interface MeterConfig {
  readonly count: number;
  readonly perMs: number;
  readonly burst: number;
}

export interface BudgetConfig {
  /** Everything through this egress, whatever the credential. Covers per-IP. */
  readonly global: MeterConfig;
  /** Per API key. Covers per-key. */
  readonly credential: MeterConfig;
  /** Extra ceiling from the FAQ's "16/sec", as a burst guard. */
  readonly perSecond: MeterConfig;
  /** How long a 429 with no usable header parks a scope for. */
  readonly defaultPenaltyMs: number;
  /** Refuse rather than queue forever. A caller blocked this long is a bug. */
  readonly maxWaitMs: number;
}

/**
 * Seeded at the tightest published figure — 100 requests / 60 s — not the FAQ's
 * 960/min. The plan called 16/s + 960/min "pessimistic"; it is not, it is 9.6x
 * looser than the help site's 100/min. Widening is a config change gated on
 * T01.5 and E3, and on nothing else.
 */
export const DEFAULT_BUDGET: BudgetConfig = {
  global: { count: 100, perMs: 60_000, burst: 25 },
  credential: { count: 100, perMs: 60_000, burst: 25 },
  perSecond: { count: 16, perMs: 1_000, burst: 16 },
  defaultPenaltyMs: 60_000,
  maxWaitMs: 120_000,
};

// ------------------------------------------------------------------ the meter

/** Mutable state for one metered scope. One number, so Redis can hold it. */
interface MeterState {
  /** GCRA's theoretical arrival time: when the next request becomes due. */
  tatMs: number;
  /** Set by a 429. Nothing goes out for this scope until now() passes it. */
  parkedUntilMs: number;
}

/**
 * GCRA. `interval` is the time cost of one request; `tolerance` is how far ahead
 * of real time the schedule may run, which is the burst. A request is allowed
 * when its new arrival time is no more than `tolerance` in the future, and the
 * amount by which it exceeds that is exactly how long the caller must wait.
 */
export class Meter {
  private readonly intervalMs: number;
  private readonly toleranceMs: number;
  private readonly state: MeterState;

  constructor(readonly name: string, config: MeterConfig, nowMs: number) {
    if (config.count <= 0 || config.perMs <= 0 || config.burst <= 0) {
      throw new RateBudgetError(`${name}: count, perMs and burst must all be positive`);
    }
    this.intervalMs = config.perMs / config.count;
    this.toleranceMs = this.intervalMs * config.burst;
    this.state = { tatMs: nowMs, parkedUntilMs: 0 };
  }

  /** How long until a request may go out. 0 means now. Does not consume. */
  waitMs(nowMs: number): number {
    const parked = Math.max(0, this.state.parkedUntilMs - nowMs);
    const due = Math.max(this.state.tatMs, nowMs) + this.intervalMs;
    const scheduled = Math.max(0, due - nowMs - this.toleranceMs);
    return Math.max(parked, scheduled);
  }

  /** Consume one slot. Only valid when `waitMs` returned 0. */
  commit(nowMs: number): void {
    this.state.tatMs = Math.max(this.state.tatMs, nowMs) + this.intervalMs;
  }

  /** Park the scope: a 429 means the venue has told us our model is wrong. */
  park(untilMs: number): void {
    this.state.parkedUntilMs = Math.max(this.state.parkedUntilMs, untilMs);
  }

  /**
   * Narrow the schedule to match what the venue says is left. Called with the
   * venue's own `remaining` and window; only ever tightens, because the whole
   * rule from 06 F6 is that we widen against measurement, never against a claim.
   */
  narrowTo(remaining: number, windowMs: number, nowMs: number): boolean {
    if (remaining < 0 || windowMs <= 0) return false;
    // Spread whatever is left evenly over the rest of the window, then set the
    // schedule to that pace if it is slower than what we are already doing.
    const impliedTat = remaining === 0 ? nowMs + windowMs : nowMs + windowMs / (remaining + 1);
    if (impliedTat <= this.state.tatMs) return false;
    this.state.tatMs = impliedTat;
    return true;
  }

  /** For tests and for the operational read-out. */
  snapshot(nowMs: number): { name: string; waitMs: number; parkedMs: number } {
    return {
      name: this.name,
      waitMs: this.waitMs(nowMs),
      parkedMs: Math.max(0, this.state.parkedUntilMs - nowMs),
    };
  }
}

// ----------------------------------------------------------------- the budget

/** What the venue told us about our own consumption, if anything. */
export interface RateFeedback {
  /** Requests left in the current window, per the venue. */
  readonly remaining?: number | undefined;
  /** Seconds until the window resets, per the venue. */
  readonly resetSeconds?: number | undefined;
  /** True when the response came from a cache and its counters are not ours. */
  readonly fromCache?: boolean | undefined;
  /** True when the venue returned 429. */
  readonly throttled?: boolean | undefined;
}

export interface AcquireResult {
  /** How long the caller actually waited. 0 when it went straight through. */
  readonly waitedMs: number;
  /** Which meter held it up, for the operational read-out. */
  readonly blockedBy: string | null;
}

/**
 * `acquire()` blocks rather than rejects (the phase-01 interface contract). A
 * rejection would force every caller to invent its own retry, and a retry loop
 * around order placement is how duplicate orders happen.
 */
export class RateBudget {
  private readonly global: Meter;
  private readonly perSecond: Meter;
  private readonly perCredential = new Map<string, Meter>();
  /** One promise chain per credential, so waiters are served in arrival order. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly config: BudgetConfig = DEFAULT_BUDGET,
    private readonly clock: Clock = systemClock,
  ) {
    const now = clock.now();
    this.global = new Meter('global', config.global, now);
    this.perSecond = new Meter('perSecond', config.perSecond, now);
  }

  private credentialMeter(credentialId: string): Meter {
    const existing = this.perCredential.get(credentialId);
    if (existing !== undefined) return existing;
    const meter = new Meter(`credential:${credentialId}`, this.config.credential, this.clock.now());
    this.perCredential.set(credentialId, meter);
    return meter;
  }

  private metersFor(credentialId: string | null): Meter[] {
    const meters = [this.global, this.perSecond];
    if (credentialId !== null) meters.push(this.credentialMeter(credentialId));
    return meters;
  }

  /** Longest wait across every meter that applies. Does not consume anything. */
  peekWaitMs(credentialId: string | null = null): number {
    const now = this.clock.now();
    return Math.max(0, ...this.metersFor(credentialId).map((m) => m.waitMs(now)));
  }

  /**
   * Wait until a request may go out, then consume one slot from every meter.
   *
   * Serialised per credential (and globally for unauthenticated calls) so that
   * two concurrent callers cannot both observe "wait 0" and then both commit —
   * the check and the commit have to be one step or the burst limit leaks.
   */
  async acquire(credentialId: string | null = null): Promise<AcquireResult> {
    const lane = credentialId ?? '@global';
    const previous = this.queues.get(lane) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.then(() => mine);
    this.queues.set(lane, chained);
    await previous;
    try {
      return await this.acquireExclusive(credentialId);
    } finally {
      release();
      if (this.queues.get(lane) === chained) this.queues.delete(lane);
    }
  }

  private async acquireExclusive(credentialId: string | null): Promise<AcquireResult> {
    const startedAt = this.clock.now();
    let requestedMs = 0;
    let blockedBy: string | null = null;

    for (;;) {
      const now = this.clock.now();
      const meters = this.metersFor(credentialId);
      let worst = 0;
      let worstName: string | null = null;
      for (const m of meters) {
        const w = m.waitMs(now);
        if (w > worst) { worst = w; worstName = m.name; }
      }

      if (worst === 0) {
        // Check and commit are one step, under the lane lock. Split them and two
        // concurrent callers both read "wait 0" and the burst limit leaks.
        for (const m of meters) m.commit(now);
        return { waitedMs: Math.max(0, now - startedAt), blockedBy };
      }

      blockedBy = worstName;
      requestedMs += worst;
      if (requestedMs > this.config.maxWaitMs) {
        // Counted on requested sleep, not measured elapsed, so a stopped clock
        // cannot turn this into an infinite loop.
        throw new RateBudgetError(
          `${worstName} would hold this request for ${requestedMs}ms, over the ${this.config.maxWaitMs}ms limit`,
        );
      }
      await this.clock.sleep(worst);
    }
  }

  /**
   * Feed the venue's own accounting back into the model.
   *
   * Only ever tightens. 06 F6's rule is that the four published figures may not
   * be trusted and only measurement may widen a limit, and a response header is
   * a claim about one route at one instant, not a measurement of our budget.
   */
  observe(feedback: RateFeedback, credentialId: string | null = null): { narrowed: string[]; parkedMs: number } {
    const now = this.clock.now();
    const meters = this.metersFor(credentialId);

    if (feedback.throttled === true) {
      // No Retry-After is ever sent (06 F6.2), so the window is ours to infer.
      const penalty = feedback.resetSeconds !== undefined && feedback.resetSeconds > 0
        ? feedback.resetSeconds * 1_000
        : this.config.defaultPenaltyMs;
      for (const m of meters) m.park(now + penalty);
      return { narrowed: meters.map((m) => m.name), parkedMs: penalty };
    }

    // A cached response's counters belong to whoever missed the cache last.
    // Metering off them would tighten or loosen against a stranger's traffic.
    if (feedback.fromCache === true) return { narrowed: [], parkedMs: 0 };
    if (feedback.remaining === undefined || feedback.resetSeconds === undefined) {
      return { narrowed: [], parkedMs: 0 };
    }

    const narrowed: string[] = [];
    for (const m of meters) {
      if (m.narrowTo(feedback.remaining, feedback.resetSeconds * 1_000, now)) narrowed.push(m.name);
    }
    return { narrowed, parkedMs: 0 };
  }

  /** Operational read-out: what is holding traffic up right now, and for how long. */
  inspect(credentialId: string | null = null): ReadonlyArray<{ name: string; waitMs: number; parkedMs: number }> {
    const now = this.clock.now();
    return this.metersFor(credentialId).map((m) => m.snapshot(now));
  }
}
