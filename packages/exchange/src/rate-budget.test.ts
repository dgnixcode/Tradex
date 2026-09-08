// The budget is tested on a driven clock, not on real time: a test that sleeps
// for a real second to prove a one-second limit is a slow test that still cannot
// prove the arithmetic. `sleep` advances the clock by exactly what was asked for,
// so every wait below is the number the algorithm computed.
// Sources: 06 F6 (the four contradicting limits), 22 F3.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET, Meter, RateBudget, RateBudgetError, systemClock,
} from './rate-budget.js';
import type { BudgetConfig, Clock } from './rate-budget.js';

/** A clock the test drives. `sleep` is the only thing that moves it. */
const driven = (): Clock & { advance: (ms: number) => void; elapsed: () => number } => {
  let t = 1_757_000_000_000;
  const start = t;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; },
    elapsed: () => t - start,
  };
};

const config = (over: Partial<BudgetConfig> = {}): BudgetConfig => ({ ...DEFAULT_BUDGET, ...over });

describe('the seeded default is the tightest published figure, not the loosest', () => {
  it('is 100 per 60s, not the FAQ 960 per minute', () => {
    // The plan doc called "16/s and 960/min" pessimistic. It is 9.6x looser than
    // the help site's 100/min, which is the tightest of the four published
    // figures and therefore the only safe seed (06 F6).
    expect(DEFAULT_BUDGET.global.count).toBe(100);
    expect(DEFAULT_BUDGET.global.perMs).toBe(60_000);
    expect(DEFAULT_BUDGET.credential.count).toBe(100);
    expect(DEFAULT_BUDGET.perSecond).toEqual({ count: 16, perMs: 1_000, burst: 16 });
  });

  it('has a burst large enough for a 20-account fan-out', () => {
    // 20 accounts is the stated size of a big customer. A burst below that turns
    // every group trade into a queue, which spreads the fills in time.
    expect(DEFAULT_BUDGET.global.burst).toBeGreaterThanOrEqual(20);
  });

  it('is configuration, so changing a limit needs no code edit', () => {
    const tight = new RateBudget(config({ global: { count: 1, perMs: 10_000, burst: 1 } }), driven());
    expect(tight.inspect()[0]?.name).toBe('global');
  });
});

describe('requests queue rather than fire', () => {
  it('lets the burst through immediately and paces the rest', async () => {
    const clock = driven();
    // 10 per second, burst 3: three go instantly, then one every 100ms.
    const budget = new RateBudget(config({
      global: { count: 10, perMs: 1_000, burst: 3 },
      perSecond: { count: 1_000, perMs: 1_000, burst: 1_000 },
    }), clock);

    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) waits.push((await budget.acquire()).waitedMs);

    expect(waits.slice(0, 3)).toEqual([0, 0, 0]);
    expect(waits.slice(3)).toEqual([100, 100, 100]);
    expect(clock.elapsed()).toBe(300);
  });

  it('never fires more than the limit allows over a window', async () => {
    const clock = driven();
    const budget = new RateBudget(config({
      global: { count: 5, perMs: 1_000, burst: 5 },
      perSecond: { count: 1_000, perMs: 1_000, burst: 1_000 },
    }), clock);

    for (let i = 0; i < 15; i += 1) await budget.acquire();
    // 15 requests at 5/s: the burst covers the first 5, the rest cost 200ms each.
    expect(clock.elapsed()).toBe(2_000);
    expect(15 / (clock.elapsed() / 1_000 + 1)).toBeLessThanOrEqual(5);
  });

  it('applies the per-second ceiling on top of the per-minute one', async () => {
    const clock = driven();
    const budget = new RateBudget(config({
      global: { count: 100, perMs: 60_000, burst: 100 },
      perSecond: { count: 4, perMs: 1_000, burst: 4 },
    }), clock);

    const waits: number[] = [];
    for (let i = 0; i < 8; i += 1) waits.push((await budget.acquire()).waitedMs);
    // The minute meter would allow all 8 at once; the second meter must not.
    expect(waits.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(waits.slice(4).every((w) => w > 0)).toBe(true);
    expect(clock.elapsed()).toBe(1_000);
  });

  it('names the meter that held the request up', async () => {
    const clock = driven();
    const budget = new RateBudget(config({
      global: { count: 100, perMs: 60_000, burst: 100 },
      perSecond: { count: 1, perMs: 1_000, burst: 1 },
    }), clock);
    await budget.acquire();
    expect((await budget.acquire()).blockedBy).toBe('perSecond');
  });
});

describe('both scopes are metered, because G2 is still open', () => {
  const wide = { count: 10_000, perMs: 1_000, burst: 10_000 };

  it('one credential exhausting its own budget does not stall another', async () => {
    const clock = driven();
    const budget = new RateBudget(config({
      global: wide, perSecond: wide, credential: { count: 2, perMs: 1_000, burst: 2 },
    }), clock);

    await budget.acquire('key-a');
    await budget.acquire('key-a');
    // key-a is now out of budget; key-b must be unaffected.
    expect((await budget.acquire('key-b')).waitedMs).toBe(0);
    expect(budget.peekWaitMs('key-a')).toBeGreaterThan(0);
    expect(budget.peekWaitMs('key-b')).toBe(0);
  });

  it('the global meter still binds every credential', async () => {
    // If the venue meters per IP, per-credential budgets are irrelevant and this
    // is the meter that saves us. Metering both is the only configuration that
    // is correct whichever way T01.5 lands.
    const clock = driven();
    const budget = new RateBudget(config({
      global: { count: 2, perMs: 1_000, burst: 2 }, perSecond: wide, credential: wide,
    }), clock);

    await budget.acquire('key-a');
    await budget.acquire('key-b');
    expect((await budget.acquire('key-c')).blockedBy).toBe('global');
    expect(clock.elapsed()).toBe(500);
  });

  it('meters unauthenticated calls against the global budget too', async () => {
    const clock = driven();
    const budget = new RateBudget(config({
      global: { count: 1, perMs: 1_000, burst: 1 }, perSecond: wide, credential: wide,
    }), clock);
    await budget.acquire(null);
    expect(budget.peekWaitMs(null)).toBeGreaterThan(0);
    expect(budget.peekWaitMs('key-a')).toBeGreaterThan(0);
  });
});

describe('concurrent callers cannot both spend the last slot', () => {
  it('serialises check-and-commit', async () => {
    const clock = driven();
    const budget = new RateBudget(config({
      global: { count: 4, perMs: 1_000, burst: 1 },
      perSecond: { count: 1_000, perMs: 1_000, burst: 1_000 },
      credential: { count: 1_000, perMs: 1_000, burst: 1_000 },
    }), clock);

    // Five callers race for a burst of 1. Exactly one may report waitedMs 0.
    const results = await Promise.all(Array.from({ length: 5 }, () => budget.acquire('key-a')));
    const immediate = results.filter((r) => r.waitedMs === 0);
    expect(immediate).toHaveLength(1);
    expect(results.map((r) => r.waitedMs).sort((a, b) => a - b)).toEqual([0, 250, 250, 250, 250]);
  });
});

describe('the venue gets the last word', () => {
  const wide = { count: 10_000, perMs: 1_000, burst: 10_000 };
  const loose = (): BudgetConfig => config({ global: wide, perSecond: wide, credential: wide });

  it('tightens when the venue says less is left than we assumed', async () => {
    const clock = driven();
    const budget = new RateBudget(loose(), clock);
    expect(budget.peekWaitMs('key-a')).toBe(0);

    // 2 left in a 60s window: pace to one per 20s, not 10,000 per second.
    const out = budget.observe({ remaining: 2, resetSeconds: 60 }, 'key-a');
    expect(out.narrowed).toContain('global');
    expect(out.narrowed).toContain('credential:key-a');
    expect(budget.peekWaitMs('key-a')).toBeGreaterThan(0);
  });

  it('never widens against a header', () => {
    const clock = driven();
    const budget = new RateBudget(config({
      global: { count: 1, perMs: 60_000, burst: 1 }, perSecond: wide, credential: wide,
    }), clock);
    void budget.acquire();
    // A generous header must not undo a tight configured limit — the rule from
    // 06 F6 is that only measurement widens, never a claim.
    const before = budget.peekWaitMs();
    budget.observe({ remaining: 4_999, resetSeconds: 60 });
    expect(budget.peekWaitMs()).toBeGreaterThanOrEqual(before);
  });

  it('ignores counters from a cached response', () => {
    // On a Cloudflare HIT the numbers describe whoever missed last (06 F6.2).
    const budget = new RateBudget(loose(), driven());
    expect(budget.observe({ remaining: 0, resetSeconds: 60, fromCache: true }).narrowed).toEqual([]);
    expect(budget.peekWaitMs()).toBe(0);
  });

  it('parks every applicable meter on a 429', () => {
    const clock = driven();
    const budget = new RateBudget(loose(), clock);
    const out = budget.observe({ throttled: true, resetSeconds: 8 }, 'key-a');
    expect(out.parkedMs).toBe(8_000);
    expect(budget.peekWaitMs('key-a')).toBe(8_000);
    clock.advance(8_000);
    expect(budget.peekWaitMs('key-a')).toBe(0);
  });

  it('falls back to a fixed penalty when a 429 carries nothing usable', () => {
    // CoinDCX never sends Retry-After, and the 401 probe carried no rate headers
    // at all, so a bare 429 has to mean something on its own.
    const budget = new RateBudget(loose(), driven());
    expect(budget.observe({ throttled: true }).parkedMs).toBe(DEFAULT_BUDGET.defaultPenaltyMs);
  });

  it('does nothing when there is no feedback at all', () => {
    const budget = new RateBudget(loose(), driven());
    expect(budget.observe({})).toEqual({ narrowed: [], parkedMs: 0 });
    expect(budget.peekWaitMs()).toBe(0);
  });
});

describe('a caller is never queued forever', () => {
  it('refuses once the projected wait passes maxWaitMs', async () => {
    const clock = driven();
    const budget = new RateBudget(config({
      global: { count: 1, perMs: 600_000, burst: 1 },
      perSecond: { count: 1_000, perMs: 1_000, burst: 1_000 },
      credential: { count: 1_000, perMs: 1_000, burst: 1_000 },
      maxWaitMs: 5_000,
    }), clock);

    await budget.acquire();
    await expect(budget.acquire()).rejects.toThrow(RateBudgetError);
    await expect(budget.acquire()).rejects.toThrow(/over the 5000ms limit/);
  });

  it('counts requested sleep, not measured time, so a stopped clock cannot hang it', async () => {
    // A clock whose sleep does nothing is exactly what a mistake in test setup
    // looks like. The guard has to be monotonic on its own.
    const stopped: Clock = { now: () => 1_757_000_000_000, sleep: async () => {} };
    const budget = new RateBudget(config({
      global: { count: 1, perMs: 10_000, burst: 1 },
      perSecond: { count: 1_000, perMs: 1_000, burst: 1_000 },
      credential: { count: 1_000, perMs: 1_000, burst: 1_000 },
      maxWaitMs: 30_000,
    }), stopped);
    await budget.acquire();
    await expect(budget.acquire()).rejects.toThrow(RateBudgetError);
  });

  it('rejects a nonsensical meter rather than dividing by zero', () => {
    expect(() => new Meter('x', { count: 0, perMs: 1_000, burst: 1 }, 0)).toThrow(RateBudgetError);
    expect(() => new Meter('x', { count: 1, perMs: 0, burst: 1 }, 0)).toThrow(/must all be positive/);
    expect(() => new Meter('x', { count: 1, perMs: 1_000, burst: 0 }, 0)).toThrow(RateBudgetError);
  });
});

describe('the real clock is wired up', () => {
  it('sleeps and advances', async () => {
    const before = systemClock.now();
    await systemClock.sleep(12);
    expect(systemClock.now() - before).toBeGreaterThanOrEqual(10);
  });
});
