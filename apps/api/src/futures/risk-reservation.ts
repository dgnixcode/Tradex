import { dailySpentMinor, readAccountStates, readMarketStates, readTenantCaps } from '@tradex/db';
import type { DB, TenantDb } from '@tradex/db';
import type { Kysely } from 'kysely';

const unit = 10n ** 18n;
const scaled = (s: string): bigint => {
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new Error('A positive plain decimal is required');
  const [whole = '0', fraction = ''] = s.split('.');
  return BigInt(whole) * unit + BigInt(fraction.padEnd(18, '0'));
};

/** Exact margin in INR paise, rounded up when checking a risk limit. */
export function marginInrMinor(quantity: string, price: string, leverage: number, quote: 'INR' | 'USDT', rate: string): string {
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 200) throw new Error('Invalid leverage');
  const fx = quote === 'USDT' ? scaled(rate) : unit;
  if (fx <= 0n) throw new Error('INR/USDT rate must be positive');
  const numerator = scaled(quantity) * scaled(price) * fx * 100n;
  const denominator = unit ** 3n * BigInt(leverage);
  return String((numerator + denominator - 1n) / denominator);
}

/** Reserve an add-to-position against the same serialized budget as new entries. */
export async function reservePositionIncrease(args: {
  db: Kysely<DB>; tdb: TenantDb; requestId: string; accountId: string; pair: string;
  quantity: string; price: string; leverage: number; quote: 'INR' | 'USDT'; usdtInrMid: string;
  nowMs?: number;
}): Promise<void> {
  const margin = BigInt(marginInrMinor(args.quantity, args.price, args.leverage, args.quote, args.usdtInrMid));
  const now = args.nowMs ?? Date.now();
  const offset = 330 * 60_000;
  const since = Math.floor((now + offset) / 86_400_000) * 86_400_000 - offset;
  await args.tdb.transaction(async (tdb) => {
    await tdb.lockPlanning();
    const [caps, accounts, markets, spent] = await Promise.all([
      readTenantCaps(tdb), readAccountStates(tdb, [args.accountId]), readMarketStates(args.db, [args.pair, args.pair.replace(/^[^-]+-/, '').replace('_', '')]),
      dailySpentMinor(tdb, args.accountId, 'INR', since, true, args.usdtInrMid),
    ]);
    const account = accounts.get(args.accountId);
    if (caps.tradingPaused || account?.status !== 'active' || account.credentialStatus !== 'active' || account.frozenReason !== null) {
      throw new Error('Trading permission changed; increase is blocked');
    }
    if (Object.values(markets).some((m) => m.mode !== 'normal')) throw new Error('This market is restricted; increase is blocked');
    if (margin > BigInt(account.maxOrderNotionalMinor ?? caps.perOrderNotionalMinor)) throw new Error('Increase exceeds the per-order margin limit');
    if (margin + BigInt(spent) > BigInt(caps.dailyNotionalMinor)) throw new Error('Increase exceeds the daily margin limit');
    const saved = await tdb.updateTable('position_mutation').set({ risk_margin_inr_minor: String(margin) })
      .where('request_id', '=', args.requestId).where('account_id', '=', args.accountId).where('status', '=', 'sending')
      .returning('request_id').executeTakeFirst();
    if (!saved) throw new Error('Missing durable position action receipt');
  });
}

