// FX snapshot storage — plan/phase-03 T03.8, from 10 F4.
//
// Insert and read. There is deliberately no update and no delete, and not merely
// because none is written here: the table carries an append-only trigger, so a
// mutation attempted through any other path — psql, a migration script, a future
// repo written in a hurry — fails at the database.
//
// The rule being protected is 10 F4's: a stored rate is never refreshed. Display
// rates move every few seconds, but a rate written onto a child order or a ledger
// entry is frozen forever, because re-resolving it silently moves last month's
// P&L (invariants L9, L10). Insert-only is how that becomes a guarantee instead
// of a habit.
//
// The arithmetic — the drift figure, the alarm decision — lives in
// `@tradex/sizing`'s pure `fx.ts`. This file only persists what that produced,
// so the number in the database and the number in a replay cannot diverge.

import type { Kysely } from 'kysely';
import type { DB, FxSource } from './schema.js';

export class FxRepoError extends Error {
  override readonly name = 'FxRepoError';
}

/** Mirrors `FxCrossCheck` in @tradex/sizing, which is where it is computed. */
export interface FxCrossCheckRecord {
  readonly baseLegPrice: string;
  readonly quoteLegPrice: string;
  /** Signed integer basis points. */
  readonly driftBp: string;
  readonly thresholdBp: string;
  readonly alarmed: boolean;
}

export interface NewFxSnapshot {
  readonly base: string;
  readonly quote: string;
  /** Units of `quote` per one `base`. Plain decimal, exactly as observed. */
  readonly rate: string;
  readonly source: FxSource;
  readonly observedAt: Date;
  readonly crossCheck?: FxCrossCheckRecord | undefined;
}

export interface StoredFxSnapshot extends NewFxSnapshot {
  /** The id every cross-currency figure must reference (X10). */
  readonly id: string;
}

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;
const SIGNED_INTEGER = /^-?\d+$/;

/**
 * Insert one snapshot and return its id.
 *
 * The `cross_*` columns are all-or-nothing at the database too. A drift with no
 * threshold cannot be judged and an alarm with no drift cannot be explained, so
 * a CHECK rejects a partial record rather than storing an unreadable one — and a
 * second CHECK rejects an `alarmed` flag that disagrees with its own numbers,
 * which is why the alarm is not a field a writer gets to assert.
 */
export async function insertFxSnapshot(db: Kysely<DB>, snap: NewFxSnapshot): Promise<string> {
  if (snap.base === snap.quote) {
    throw new FxRepoError(`an fx snapshot needs two different currencies, got ${snap.base} twice`);
  }
  if (!PLAIN_DECIMAL.test(snap.rate)) {
    throw new FxRepoError(
      `the rate ${snap.rate} is not a plain positive decimal — exponent notation and signs are how float error enters`,
    );
  }
  const cross = snap.crossCheck;
  if (cross !== undefined) {
    for (const [field, value] of [['baseLegPrice', cross.baseLegPrice], ['quoteLegPrice', cross.quoteLegPrice]] as const) {
      if (!PLAIN_DECIMAL.test(value)) throw new FxRepoError(`crossCheck.${field} is not a plain decimal: ${value}`);
    }
    if (!SIGNED_INTEGER.test(cross.driftBp)) {
      throw new FxRepoError(`crossCheck.driftBp must be whole basis points, got ${cross.driftBp}`);
    }
    if (!/^\d+$/.test(cross.thresholdBp) || cross.thresholdBp === '0') {
      throw new FxRepoError(`crossCheck.thresholdBp must be a positive whole number of basis points, got ${cross.thresholdBp}`);
    }
    const expected = (cross.driftBp.startsWith('-') ? cross.driftBp.slice(1) : cross.driftBp);
    if (cross.alarmed !== (BigInt(expected) > BigInt(cross.thresholdBp))) {
      throw new FxRepoError(
        `crossCheck.alarmed is ${cross.alarmed} but |${cross.driftBp}|bp against a ${cross.thresholdBp}bp threshold says otherwise`,
      );
    }
  }

  const row = await db
    .insertInto('fx_snapshot')
    .values({
      base: snap.base,
      quote: snap.quote,
      rate: snap.rate,
      source: snap.source,
      observed_at: snap.observedAt,
      cross_base_rate: cross?.baseLegPrice ?? null,
      cross_quote_rate: cross?.quoteLegPrice ?? null,
      cross_drift_bp: cross?.driftBp ?? null,
      cross_threshold_bp: cross?.thresholdBp ?? null,
      cross_alarmed: cross?.alarmed ?? null,
    } as never)
    .returning('id')
    .executeTakeFirst();
  if (row === undefined) throw new FxRepoError('the fx snapshot insert returned no id');
  return String((row as { id: string }).id);
}

const toStored = (row: {
  id: string | number; base: string; quote: string; rate: string; source: FxSource;
  observed_at: Date | string;
  cross_base_rate: string | null; cross_quote_rate: string | null;
  cross_drift_bp: string | null; cross_threshold_bp: string | null; cross_alarmed: boolean | null;
}): StoredFxSnapshot => ({
  id: String(row.id),
  base: row.base,
  quote: row.quote,
  rate: row.rate,
  source: row.source,
  observedAt: row.observed_at instanceof Date ? row.observed_at : new Date(row.observed_at),
  ...(row.cross_drift_bp !== null && row.cross_base_rate !== null && row.cross_quote_rate !== null
    && row.cross_threshold_bp !== null && row.cross_alarmed !== null
    ? {
      crossCheck: {
        baseLegPrice: row.cross_base_rate,
        quoteLegPrice: row.cross_quote_rate,
        driftBp: row.cross_drift_bp,
        thresholdBp: row.cross_threshold_bp,
        alarmed: row.cross_alarmed,
      },
    }
    : {}),
});

/** Read one snapshot back by the id an order or ledger entry recorded. */
export async function fxSnapshotById(db: Kysely<DB>, id: string): Promise<StoredFxSnapshot | null> {
  if (!/^\d+$/.test(id)) throw new FxRepoError(`not an fx snapshot id: ${id}`);
  const row = await db.selectFrom('fx_snapshot').selectAll().where('id', '=', id as never).executeTakeFirst();
  return row === undefined ? null : toStored(row as never);
}

/**
 * The most recently observed snapshot for a pair.
 *
 * Useful for display and for deciding a fresh sample is due. It is NOT how a
 * historical figure is valued: that reads the id it stored, or the figure moves.
 */
export async function latestFxSnapshot(
  db: Kysely<DB>,
  base: string,
  quote: string,
): Promise<StoredFxSnapshot | null> {
  const row = await db
    .selectFrom('fx_snapshot')
    .selectAll()
    .where('base', '=', base)
    .where('quote', '=', quote)
    .orderBy('observed_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? null : toStored(row as never);
}

/** Snapshots whose cross-check alarmed, newest first — the 10 F4 alarm feed. */
export async function alarmedFxSnapshots(db: Kysely<DB>, limit = 50): Promise<readonly StoredFxSnapshot[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new FxRepoError(`limit must be a positive integer, got ${limit}`);
  const rows = await db
    .selectFrom('fx_snapshot')
    .selectAll()
    .where('cross_alarmed', '=', true)
    .orderBy('observed_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => toStored(r as never));
}
