// The positions builder — plan/phase-09 T09.6.
//
// Reads the `holding` projection (the fold of ledger_entry) and shows each current
// position as-is: quantity, weighted-average cost, realised P&L, fee drag and TDS.
// This is deliberately the BOOKS, never a mark-to-market re-valuation — the §6a
// boundary (011 creates no equity_snapshot, and 07-no-mark-to-market scans this
// directory for a valuation vocabulary). There is no unrealised anything here.
//
// The only derived figures are presentational, not bookkeeping:
//   - avgPriceMinor — the fold's own weighted-average cost: cost_total_minor ÷ qty
//     in quote minor per one whole asset (what the fills actually averaged to);
//   - dust — a non-zero holding below the asset's market effective minimum, the
//     same threshold a sell would refuse to send (packages/sizing effective-min).
//   - the per-quote roll-up — plain sums of the signed minor columns across the
//     accounts' positions (quantity is not summed across assets).

import { latestMarketMetadataVersion, listHeldPositions, listOpenOrdersForAccounts, loadMarketRules } from '@tradex/db';
import type { DB, TenantDb } from '@tradex/db';
import type { Kysely } from 'kysely';
import { div, scaledFromMinor } from '@tradex/money';
import { effectiveMinQty, meetsEffectiveMin, nat } from '@tradex/sizing';
import type { MarketRules } from '@tradex/exchange';

/** An account to resolve positions for, with the name the screen should show. */
export interface NamedAccount {
  readonly accountId: string;
  readonly accountName: string;
}

/** One current holding in one asset, with its books. */
export interface PositionView {
  readonly asset: string;
  readonly quoteAsset: 'INR' | 'USDT';
  readonly qty: string;
  /** Weighted-average cost in quote minor per one whole asset; null when flat/zero-cost. */
  readonly avgPriceMinor: string | null;
  readonly costTotalMinor: string;
  readonly realisedPnlMinor: string;
  readonly feeDragMinor: string;
  readonly tdsWithheldMinor: string;
  /** True when qty > 0 but below the market's effective minimum (unsellable dust). */
  readonly dust: boolean;
}

/** A child order still live at the venue — what locks part of the holding. */
export interface OpenOrderView {
  readonly market: string;
  readonly asset: string;
  readonly quoteAsset: 'INR' | 'USDT';
  readonly side: string;
  readonly state: string;
  readonly quantity: string;
}

export interface AccountPositions {
  readonly accountId: string;
  readonly accountName: string;
  readonly positions: readonly PositionView[];
  readonly openOrders: readonly OpenOrderView[];
}

/** Per-currency subtotals across the resolved accounts. */
export interface QuoteRollup {
  readonly quoteAsset: 'INR' | 'USDT';
  readonly accountCount: number;
  readonly openPositionCount: number;
  readonly dustCount: number;
  readonly costTotalMinor: string;
  readonly realisedPnlMinor: string;
  readonly feeDragMinor: string;
  readonly tdsWithheldMinor: string;
}

export interface PositionsResponse {
  readonly accounts: readonly AccountPositions[];
  readonly rollup: readonly QuoteRollup[];
  readonly at: string;
}

const quoteOf = (market: string, asset: string): 'INR' | 'USDT' => {
  const rest = market.slice(asset.length);
  return rest === 'INR' || rest === 'USDT' ? rest : rest.startsWith('INR') ? 'INR' : 'USDT';
};

/**
 * Build the positions view for a set of accounts. `db` is the untagged handle
 * used to read the GLOBAL market metadata (the dust floor); `tdb` scopes the
 * per-account reads.
 */
export async function buildPositions(
  db: Kysely<DB>,
  tdb: TenantDb,
  accounts: readonly NamedAccount[],
): Promise<PositionsResponse> {
  const ids = accounts.map((a) => a.accountId);
  const [held, openRows] = await Promise.all([
    listHeldPositions(tdb, ids),
    listOpenOrdersForAccounts(tdb, ids),
  ]);

  // The current market rules, indexed by venue symbol, for the dust floor. Absent
  // metadata (a tenant with no ingested markets) simply means no dust flags.
  let rulesBySymbol = new Map<string, MarketRules>();
  try {
    const version = await latestMarketMetadataVersion(db);
    if (version !== null) {
      const rules = await loadMarketRules(db, version);
      rulesBySymbol = new Map(rules.map((r) => [r.venueSymbol, r]));
    }
  } catch {
    // Market metadata is a read optimisation for the dust flag; its absence must
    // never break the positions screen.
    rulesBySymbol = new Map();
  }

  const openByAccount = new Map<string, OpenOrderView[]>();
  for (const o of openRows) {
    const list = openByAccount.get(o.accountId);
    const view: OpenOrderView = {
      market: o.market, asset: o.asset,
      quoteAsset: quoteOf(o.market, o.asset),
      side: o.side, state: o.state, quantity: o.quantity,
    };
    if (list === undefined) openByAccount.set(o.accountId, [view]); else list.push(view);
  }

  const positionsByAccount = new Map<string, PositionView[]>();
  interface RollupAcc {
    quoteAsset: 'INR' | 'USDT'; accountCount: number; openPositionCount: number;
    dustCount: number; costTotalMinor: string; realisedPnlMinor: string;
    feeDragMinor: string; tdsWithheldMinor: string;
  }
  const rollupByQuote = new Map<'INR' | 'USDT', RollupAcc>();
  const zeroRollup = (q: 'INR' | 'USDT'): RollupAcc => ({
    quoteAsset: q, accountCount: 0, openPositionCount: 0, dustCount: 0,
    costTotalMinor: '0', realisedPnlMinor: '0', feeDragMinor: '0', tdsWithheldMinor: '0',
  });

  for (const h of held) {
    const qty = nat(h.qty);
    const min = rulesBySymbol.get(`${h.asset}${h.quoteAsset}`);
    const dust = min !== undefined && !meetsEffectiveMin(qty, effectiveMinQty(min, 'market'));
    const avgPriceMinor = h.costTotalMinor === '0'
      ? null
      : div(scaledFromMinor(h.costTotalMinor, 0), qty, 0).v.toString();
    const view: PositionView = {
      asset: h.asset, quoteAsset: h.quoteAsset, qty: h.qty,
      avgPriceMinor, costTotalMinor: h.costTotalMinor,
      realisedPnlMinor: h.realisedPnlMinor, feeDragMinor: h.feeDragMinor,
      tdsWithheldMinor: h.tdsWithheldMinor, dust,
    };
    const list = positionsByAccount.get(h.accountId);
    if (list === undefined) positionsByAccount.set(h.accountId, [view]); else list.push(view);

    let rq = rollupByQuote.get(h.quoteAsset);
    if (rq === undefined) { rq = zeroRollup(h.quoteAsset); rollupByQuote.set(h.quoteAsset, rq); }
    rq.openPositionCount += 1;
    if (dust) rq.dustCount += 1;
    rq.costTotalMinor = (BigInt(rq.costTotalMinor) + BigInt(h.costTotalMinor)).toString();
    rq.realisedPnlMinor = (BigInt(rq.realisedPnlMinor) + BigInt(h.realisedPnlMinor)).toString();
    rq.feeDragMinor = (BigInt(rq.feeDragMinor) + BigInt(h.feeDragMinor)).toString();
    rq.tdsWithheldMinor = (BigInt(rq.tdsWithheldMinor) + BigInt(h.tdsWithheldMinor)).toString();
  }

  const accountViews: AccountPositions[] = accounts.map((a) => ({
    accountId: a.accountId,
    accountName: a.accountName,
    positions: positionsByAccount.get(a.accountId) ?? [],
    openOrders: openByAccount.get(a.accountId) ?? [],
  }));

  // A quote only rolls up when at least one account holds something in it; an
  // account that touches a quote only through an open order is not counted.
  const seenQuoteAccounts = new Map<'INR' | 'USDT', Set<string>>();
  for (const acc of accountViews) {
    const quotes = new Set(acc.positions.map((p) => p.quoteAsset));
    for (const q of quotes) {
      let set = seenQuoteAccounts.get(q);
      if (set === undefined) { set = new Set(); seenQuoteAccounts.set(q, set); }
      set.add(acc.accountId);
    }
  }
  for (const [q, set] of seenQuoteAccounts) {
    const rq = rollupByQuote.get(q);
    if (rq !== undefined) rq.accountCount = set.size;
  }

  return {
    accounts: accountViews,
    rollup: [...rollupByQuote.values()],
    at: new Date().toISOString(),
  };
}
