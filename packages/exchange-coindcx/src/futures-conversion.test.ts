import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { fetchFuturesSettlementRate } from './futures-conversion.js';
import { destroyAllAgents } from './http.js';
let server: Server | undefined;
afterEach(async () => { destroyAllAgents(); if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });
async function serve(body: string, status = 200) {
  server = createServer((req,res) => {
    expect(req.method).toBe('GET'); expect(req.url).toBe('/api/v1/derivatives/futures/data/conversions');
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(body);
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  return `http://127.0.0.1:${address.port}`;
}
const row = '{"symbol":"USDTINR","margin_currency_short_name":"INR","target_currency_short_name":"USDT","conversion_price":102.123456789123456789}';
it('reads the separate fixed settlement price exactly using a non-trading GET', async () => {
  const result = await fetchFuturesSettlementRate({ baseUrl: await serve(`[${row}]`) });
  expect(result.ok).toBe(true); if (result.ok) expect(result.rate).toBe('102.123456789123456789');
});
it.each(['[]', `[${row},${row}]`, row, 'not json', `[${row.replace('102.123456789123456789','0')}]`, `[${row.replace('"INR"','"USDT"')}]`])('fails closed on an unverifiable conversion: %s', async body => {
  expect((await fetchFuturesSettlementRate({ baseUrl: await serve(body) })).ok).toBe(false);
});
it('does not substitute a spot FX price during a rate-limit outage', async () => {
  expect((await fetchFuturesSettlementRate({ baseUrl: await serve('{}',429) })).ok).toBe(false);
});
