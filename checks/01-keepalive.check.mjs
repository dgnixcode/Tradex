// 01-keepalive — plan/phase-01 T01.3, the half that needs the real venue.
//
// packages/exchange-coindcx/src/http.test.ts proves reuse against a loopback
// server, where the whole handshake costs microseconds. That test can tell you
// the pool works; it cannot tell you the pool is worth having. This one measures
// the real number `17` F1 claims: ~105 ms cold to api.coindcx.com against ~38 ms
// warm, which across a 20-account fan-out is over a second of drift per leg.
//
// Gated on TRADEX_LIVE_VENUE so `npm run verify` never depends on the network.
// Uses a public, unauthenticated, 68-byte endpoint: no key, no rate-limit risk,
// and a body small enough that TTFB is the handshake and nothing else.

const URL_UNDER_TEST = 'https://api.coindcx.com/market_data/trade_history?pair=B-BTC_USDT&limit=1';
const WARM_REQUESTS = 6;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};

export async function run(assert) {
  if (process.env['TRADEX_LIVE_VENUE'] !== '1') {
    console.log('     (skipped: set TRADEX_LIVE_VENUE=1 to measure against api.coindcx.com)');
    assert(true, 'skipped without TRADEX_LIVE_VENUE');
    return;
  }

  const { destroyAllAgents, send } = await import('../packages/exchange-coindcx/dist/index.js');
  const url = new URL(URL_UNDER_TEST);

  let cold;
  try {
    cold = await send({ method: 'GET', url, deadlineMs: 20_000 });
  } catch (err) {
    console.log(`     (skipped: api.coindcx.com unreachable — ${err.message})`);
    assert(true, 'skipped: venue unreachable');
    destroyAllAgents();
    return;
  }

  try {
    assert(cold.status === 200, `cold request returned ${cold.status}, expected 200`);
    assert(cold.timing.reusedConnection === false, 'the first request cannot have reused a connection');
    assert(cold.body.length > 0, 'cold request returned an empty body');

    const warm = [];
    for (let i = 0; i < WARM_REQUESTS; i += 1) warm.push(await send({ method: 'GET', url, deadlineMs: 20_000 }));

    for (const [i, r] of warm.entries()) {
      assert(r.status === 200, `warm request ${i + 2} returned ${r.status}`);
      assert(r.timing.reusedConnection === true,
        `warm request ${i + 2} opened a NEW connection — keep-alive is not working against the real venue`);
      assert(r.timing.socketId === cold.timing.socketId,
        `warm request ${i + 2} used socket ${r.timing.socketId}, not ${cold.timing.socketId}`);
    }

    const warmTtfb = warm.map((r) => r.timing.ttfbMs);
    const warmMedian = median(warmTtfb);
    const saved = cold.timing.ttfbMs - warmMedian;
    console.log(`     cold TTFB ${cold.timing.ttfbMs.toFixed(1)}ms | warm median ${warmMedian.toFixed(1)}ms `
      + `| warm range ${Math.min(...warmTtfb).toFixed(1)}-${Math.max(...warmTtfb).toFixed(1)}ms `
      + `| saved ${saved.toFixed(1)}ms/call | 20-account leg saves ${(saved * 20 / 1000).toFixed(2)}s`);

    // The claim under test is that reuse is a large win, not a marginal one.
    // A tolerant threshold rather than the exact 38 ms, because RTT to Mumbai
    // varies by an order of magnitude depending on where this runs from.
    assert(warmMedian < cold.timing.ttfbMs,
      `warm median ${warmMedian.toFixed(1)}ms is not below cold ${cold.timing.ttfbMs.toFixed(1)}ms`);
    assert(warmMedian < cold.timing.ttfbMs * 0.75,
      `reuse saved only ${saved.toFixed(1)}ms (${((1 - warmMedian / cold.timing.ttfbMs) * 100).toFixed(0)}%); `
      + '17 F1 measured ~64% — either the pool is not reusing or the handshake is unusually cheap from here');
    assert(saved > 10, `reuse saved ${saved.toFixed(1)}ms, below the 10ms floor that would make pooling worth it`);

    // Reuse must not be achieved by serialising everything onto one socket.
    const t0 = performance.now();
    const parallel = await Promise.all(Array.from({ length: 3 }, () => send({ method: 'GET', url })));
    const wall = performance.now() - t0;
    const slowest = Math.max(...parallel.map((r) => r.timing.elapsedMs));
    assert(parallel.every((r) => r.status === 200), 'a parallel request failed');
    assert(wall < slowest * 2.5,
      `3 parallel requests took ${wall.toFixed(0)}ms against a slowest single call of ${slowest.toFixed(0)}ms `
      + '— the pool is serialising instead of opening concurrent sockets');
  } finally {
    destroyAllAgents();
  }
}
