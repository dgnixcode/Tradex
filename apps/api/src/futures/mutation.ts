import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { acquireFuturesLock, forTenant, releaseFuturesLock, readAccountStates, readPlatformFlags, readTenantCaps } from '@tradex/db';
import type { DB } from '@tradex/db';

/** A status read only; never cancel, attach protection, or replay an entry. */
export type ReadEntryOrder = (args: {
  tenantId: string; accountId: string; pair: string; marginCurrency: string; exchangeOrderId: string;
}) => Promise<{ id: string; pair: string; marginCurrency: string; status: string } | null>;

export class PositionMutationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Durable retry receipt and cross-process exclusion, shared by ALL position mutations. */
export async function executePositionMutation<T>(args: {
  db: Kysely<DB>; tenantId: string; accountId: string; pair: string;
  positionId: string; operation: string; body: unknown; requestId?: string | undefined;
  marginCurrency?: string | undefined;
  readEntryOrder?: ReadEntryOrder | undefined;
  execute: (lockId: string) => Promise<T>;
}): Promise<T> {
  const id = args.requestId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new PositionMutationError(400, 'Idempotency-Key must be a UUID');
  }
  const tdb = forTenant(args.db, args.tenantId);
  const [platform, caps, accounts] = await Promise.all([
    readPlatformFlags(args.db), readTenantCaps(tdb), readAccountStates(tdb, [args.accountId]),
  ]);
  const account = accounts.get(args.accountId);
  const increasesRisk = args.operation === 'leverage' || args.operation === 'margin' || (args.operation === 'adjust'
    && (args.body as { direction?: string } | null)?.direction === 'increase');
  if (platform.killSwitch || platform.mode === 'read_only' || process.env['TRADEX_KILL_SWITCH'] === '1'
    || (increasesRisk && (platform.mode !== 'normal' || caps.tradingPaused || account?.status !== 'active'
      || account.credentialStatus !== 'active' || account.frozenReason !== null))) {
    throw new PositionMutationError(403, 'Trading permission changed; this position action is blocked');
  }
  const hash = createHash('sha256').update(JSON.stringify({
    accountId: args.accountId, pair: args.pair, positionId: args.positionId, operation: args.operation, body: args.body,
  })).digest('hex');
  const inserted = await args.db.transaction().execute(async (tx) => {
    const scoped = forTenant(tx, args.tenantId);
    const receipt = await scoped.insertInto('position_mutation', {
      request_id: id, account_id: args.accountId, pair: args.pair,
      operation: args.operation, request_hash: hash, status: 'sending',
    }).onConflict((oc) => oc.columns(['tenant_id', 'request_id']).doNothing())
      .returning('request_id').executeTakeFirst();
    if (receipt === undefined) return false;
    const locked = await acquireFuturesLock(tx, {
      tenantId: args.tenantId, accountId: args.accountId, pair: args.pair,
      childOrderId: id, workerId: 'position-mutation',
    });
    if (!locked) throw new PositionMutationError(409, 'Another action on this account and pair is in progress or needs review');
    return true;
  });
  if (!inserted) {
    const previous = await tdb.selectFrom('position_mutation').selectAll()
      .where('request_id', '=', id).executeTakeFirst();
    if (previous?.request_hash !== hash) throw new PositionMutationError(409, 'Idempotency-Key was already used for a different action');
    if (previous.status === 'completed' && previous.result_json !== null) return JSON.parse(previous.result_json) as T;
    throw new PositionMutationError(409, 'This action is pending or needs review. Check the exchange before retrying.');
  }
  try {
    const unresolved = await tdb.selectFrom('position_mutation').select('request_id')
      .where('account_id', '=', args.accountId).where('pair', '=', args.pair)
      .where('status', '!=', 'completed').where('request_id', '!=', id).executeTakeFirst();
    if (unresolved !== undefined) {
      await tdb.deleteFrom('position_mutation').where('request_id', '=', id).execute();
      await releaseFuturesLock(args.db, { accountId: args.accountId, pair: args.pair, childOrderId: id });
      throw new PositionMutationError(409, 'An earlier action on this account and pair needs reconciliation');
    }
    let entryQuery = tdb.selectFrom('child_order')
      .innerJoin('group_trade', 'group_trade.id', 'child_order.group_trade_id')
      .select(['child_order.id', 'child_order.exchange_order_id', 'group_trade.margin_currency'])
      .where('child_order.account_id', '=', args.accountId).where('child_order.leg_kind', '=', 'entry')
      .where('child_order.state', 'in', ['sending', 'ambiguous', 'acked', 'open', 'partially_filled', 'unknown', 'needs_human'])
      .where('group_trade.is_futures', '=', true)
      .where('group_trade.asset', '=', args.pair.split('-').at(-1)?.split('_')[0] ?? args.pair);
    if (/^B-[A-Z0-9]+_(?:USDT|INR)$/.test(args.pair)) {
      entryQuery = entryQuery.where(eb => eb.or([
        eb('child_order.market', '=', args.pair.slice(2).replace('_', '')),
        eb('child_order.market', 'is', null),
      ]));
    }
    if (args.marginCurrency === 'INR' || args.marginCurrency === 'USDT') {
      entryQuery = entryQuery.where('group_trade.margin_currency', '=', args.marginCurrency);
    }
    const entries = await entryQuery.execute();
    const settled = new Set(['filled', 'cancelled', 'partially_cancelled', 'rejected']);
    let blocked = false;
    for (const entry of entries) {
      // Position existence and order-list absence are never fill evidence. Only
      // a fresh, terminal answer for the exact stored venue ID permits the action.
      let observed: Awaited<ReturnType<ReadEntryOrder>> = null;
      if (entry.exchange_order_id && entry.margin_currency && args.readEntryOrder) {
        observed = await args.readEntryOrder({ tenantId: args.tenantId, accountId: args.accountId,
          pair: args.pair, marginCurrency: entry.margin_currency, exchangeOrderId: entry.exchange_order_id }).catch(() => null);
      }
      if (!observed || observed.id !== entry.exchange_order_id || observed.pair !== args.pair
        || observed.marginCurrency !== entry.margin_currency || !settled.has(observed.status)) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      await tdb.deleteFrom('position_mutation').where('request_id', '=', id).execute();
      await releaseFuturesLock(args.db, { accountId: args.accountId, pair: args.pair, childOrderId: id });
      throw new PositionMutationError(409, 'An entry order on this pair is still live or its exchange status could not be verified. Check Orders and cancel or reconcile it before retrying.');
    }
    const result = await args.execute(id);
    if (typeof result === 'object' && result !== null && 'outcomeUnknown' in result && result.outcomeUnknown === true) {
      throw new PositionMutationError(409, 'The exchange outcome is unconfirmed. Check the position before taking another action.');
    }
    await tdb.updateTable('position_mutation').set({
      status: 'completed', result_json: JSON.stringify(result), completed_at: new Date(),
    }).where('request_id', '=', id).execute();
    await releaseFuturesLock(args.db, { accountId: args.accountId, pair: args.pair, childOrderId: id });
    return result;
  } catch (error) {
    // Keep the exclusion lock on unknown outcomes, including a process failure.
    await tdb.updateTable('position_mutation').set({ status: 'needs_review' })
      .where('request_id', '=', id).execute();
    throw error;
  }
}
