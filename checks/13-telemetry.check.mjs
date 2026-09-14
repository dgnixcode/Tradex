// 13-telemetry — plan/phase-13 T13.3 (offline core).
//
// The latency histogram separates WARM (reused connection) from COLD samples and
// reports mean/percentiles; the real adapter's send() flags exactly that reuse on
// the second call to the same venue (warm ~38 ms vs cold ~105 ms in production);
// and the venue's ratelimit headers surface a rate-bucket depth. The production
// baseline numbers are recorded at the go-live gate, not asserted here.

import { LatencyHistogram } from '../packages/ops/dist/index.js';
import { send, signRequest, FakeVenue, readRateFeedback } from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'ops-key-abcdef0123456789';
const SECRET = 'ops-secret-abcdef0123456789';

export async function run(assert) {
  // ---- histogram mechanics ----
  const h = new LatencyHistogram();
  h.add(105, false); // cold: a fresh connection
  h.add(98, false);
  h.add(38, true);   // warm: a reused connection
  h.add(40, true);
  h.add(37, true);
  assert(h.count === 5, `histogram must count every sample, got ${h.count}`);
  assert(h.meanWarmMs() === 38.333333333333336 || Math.abs(h.meanWarmMs() - 38.3333) < 0.01, 'warm mean ~38 ms');
  assert(h.meanColdMs() === 101.5, `cold mean ~105 ms, got ${h.meanColdMs()}`);
  assert(h.meanWarmMs() < h.meanColdMs(), 'warm must be faster than cold');
  // Sorted [37,38,40,98,105]: p50 = 40, p90 = 105.
  assert(h.percentile(50) === 40 && h.percentile(90) === 105, 'percentiles must read the sorted samples');

  // ---- the real adapter flags reuse on the second call ----
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET }, rateLimit: { limit: 100, windowSeconds: 60 } });
  const hist2 = new LatencyHistogram();
  try {
    const base = (await venue.start()).toString();
    const hit = async () => {
      const signed = signRequest(KEY, SECRET, { market: 'BTCINR' });
      const res = await send({
        method: 'POST', url: new URL('/exchange/v1/orders/active_orders', base),
        body: signed.body, headers: signed.headers, deadlineMs: 5_000,
      });
      return res;
    };

    const first = await hit();
    const second = await hit();
    assert(first.status === 200, `the venue must answer active_orders, got ${first.status}`);
    assert(first.timing.reusedConnection === false, 'the first request must open a fresh connection');
    assert(second.timing.reusedConnection === true, 'the second request must reuse the pooled connection');

    hist2.add(first.timing.ttfbMs, first.timing.reusedConnection);
    hist2.add(second.timing.ttfbMs, second.timing.reusedConnection);
    assert(hist2.meanColdMs() > 0 && hist2.count === 2, 'the histogram records the measured pair');

    // ---- rate-bucket depth from the venue's ratelimit headers ----
    const fb = readRateFeedback(second.status, second.headers);
    assert(typeof fb.remaining === 'number' && fb.remaining > 0, 'the rate feedback must parse a remaining budget');
    const bucketPct = (fb.remaining / 100) * 100;
    assert(bucketPct > 10, `the bucket must not be saturated after two calls, got ${bucketPct.toFixed(1)}%`);
  } finally {
    await venue.stop();
  }
}
