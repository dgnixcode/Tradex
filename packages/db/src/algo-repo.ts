// Repository for Algorithmic Trading strategies and execution runs.

import type { TenantDb } from './tenant-scope.js';

export interface AlgoStrategyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly targetType: 'account' | 'group';
  readonly targetId: string;
  readonly pair: string;
  readonly timeframe: string;
  readonly scheduleInterval: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | 'manual';
  readonly script: string;
  readonly params: Record<string, unknown>;
  readonly status: 'active' | 'paused' | 'stopped';
  readonly isDryRun: boolean;
  readonly lastRunAt: Date | null;
  readonly lastStatus: 'success' | 'error' | 'skipped' | null;
  readonly lastError: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AlgoStrategyInput {
  readonly id?: string | undefined;
  readonly name: string;
  readonly description?: string | null | undefined;
  readonly targetType: 'account' | 'group';
  readonly targetId: string;
  readonly pair: string;
  readonly timeframe?: string | undefined;
  readonly scheduleInterval?: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | 'manual' | undefined;
  readonly script: string;
  readonly params?: Record<string, unknown> | undefined;
  readonly status?: 'active' | 'paused' | 'stopped' | undefined;
  readonly isDryRun?: boolean | undefined;
  readonly createdBy: string;
}

export interface UpdateAlgoStrategyInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly targetType?: 'account' | 'group' | undefined;
  readonly targetId?: string | undefined;
  readonly pair?: string | undefined;
  readonly timeframe?: string | undefined;
  readonly scheduleInterval?: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | 'manual' | undefined;
  readonly script?: string | undefined;
  readonly params?: Record<string, unknown> | undefined;
  readonly status?: 'active' | 'paused' | 'stopped' | undefined;
  readonly isDryRun?: boolean | undefined;
  readonly lastRunAt?: Date | null | undefined;
  readonly lastStatus?: 'success' | 'error' | 'skipped' | null | undefined;
  readonly lastError?: string | null | undefined;
}

export interface AlgoRunRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly strategyId: string;
  readonly mode: 'backtest' | 'dry_run' | 'live';
  readonly status: 'running' | 'completed' | 'failed';
  readonly triggeredAt: Date;
  readonly completedAt: Date | null;
  readonly logs: readonly unknown[];
  readonly actionsTaken: readonly unknown[];
  readonly metrics: Record<string, unknown>;
  readonly error: string | null;
  readonly createdAt: Date;
}

export interface AlgoRunInput {
  readonly id?: string | undefined;
  readonly strategyId: string;
  readonly mode: 'backtest' | 'dry_run' | 'live';
  readonly status: 'running' | 'completed' | 'failed';
  readonly completedAt?: Date | null | undefined;
  readonly logs?: readonly unknown[] | undefined;
  readonly actionsTaken?: readonly unknown[] | undefined;
  readonly metrics?: Record<string, unknown> | undefined;
  readonly error?: string | null | undefined;
}

function mapStrategyRow(row: Record<string, unknown>): AlgoStrategyRecord {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    name: String(row['name']),
    description: row['description'] ? String(row['description']) : null,
    targetType: row['target_type'] as 'account' | 'group',
    targetId: String(row['target_id']),
    pair: String(row['pair']),
    timeframe: String(row['timeframe'] ?? '5m'),
    scheduleInterval: String(row['schedule_interval'] ?? '5m') as AlgoStrategyRecord['scheduleInterval'],
    script: String(row['script']),
    params: (typeof row['params'] === 'object' && row['params'] !== null ? row['params'] : {}) as Record<string, unknown>,
    status: (row['status'] ?? 'stopped') as 'active' | 'paused' | 'stopped',
    isDryRun: Boolean(row['is_dry_run'] ?? true),
    lastRunAt: row['last_run_at'] ? new Date(row['last_run_at'] as string | number | Date) : null,
    lastStatus: (row['last_status'] ?? null) as AlgoStrategyRecord['lastStatus'],
    lastError: row['last_error'] ? String(row['last_error']) : null,
    createdBy: String(row['created_by']),
    createdAt: new Date(row['created_at'] as string | number | Date),
    updatedAt: new Date(row['updated_at'] as string | number | Date),
  };
}

function mapRunRow(row: Record<string, unknown>): AlgoRunRecord {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    strategyId: String(row['strategy_id']),
    mode: row['mode'] as 'backtest' | 'dry_run' | 'live',
    status: row['status'] as 'running' | 'completed' | 'failed',
    triggeredAt: new Date(row['triggered_at'] as string | number | Date),
    completedAt: row['completed_at'] ? new Date(row['completed_at'] as string | number | Date) : null,
    logs: Array.isArray(row['logs']) ? row['logs'] : [],
    actionsTaken: Array.isArray(row['actions_taken']) ? row['actions_taken'] : [],
    metrics: (typeof row['metrics'] === 'object' && row['metrics'] !== null ? row['metrics'] : {}) as Record<string, unknown>,
    error: row['error'] ? String(row['error']) : null,
    createdAt: new Date(row['created_at'] as string | number | Date),
  };
}

/** List all algo strategies for the current tenant. */
export async function listAlgoStrategies(tdb: TenantDb): Promise<AlgoStrategyRecord[]> {
  const rows = await tdb
    .selectFrom('algo_strategy')
    .selectAll()
    .orderBy('created_at', 'desc')
    .execute();

  return rows.map((r) => mapStrategyRow(r as unknown as Record<string, unknown>));
}

/** Get a single algo strategy by ID. */
export async function getAlgoStrategy(tdb: TenantDb, id: string): Promise<AlgoStrategyRecord | null> {
  const row = await tdb
    .selectFrom('algo_strategy')
    .selectAll()
    .where('id', '=', id as never)
    .executeTakeFirst();

  return row ? mapStrategyRow(row as unknown as Record<string, unknown>) : null;
}

/** Create a new algo strategy. */
export async function createAlgoStrategy(tdb: TenantDb, input: AlgoStrategyInput): Promise<AlgoStrategyRecord> {
  const insertValues: Record<string, unknown> = {
    name: input.name,
    description: input.description ?? null,
    target_type: input.targetType,
    target_id: input.targetId,
    pair: input.pair,
    timeframe: input.timeframe ?? '5m',
    schedule_interval: input.scheduleInterval ?? '5m',
    script: input.script,
    params: JSON.stringify(input.params ?? {}),
    status: input.status ?? 'stopped',
    is_dry_run: input.isDryRun ?? true,
    created_by: input.createdBy,
  };

  if (input.id) {
    insertValues['id'] = input.id;
  }

  const row = await tdb
    .insertInto('algo_strategy', insertValues as never)
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapStrategyRow(row as unknown as Record<string, unknown>);
}

/** Update an existing algo strategy. */
export async function updateAlgoStrategy(
  tdb: TenantDb,
  id: string,
  input: UpdateAlgoStrategyInput,
): Promise<AlgoStrategyRecord | null> {
  const updateValues: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (input.name !== undefined) updateValues['name'] = input.name;
  if (input.description !== undefined) updateValues['description'] = input.description;
  if (input.targetType !== undefined) updateValues['target_type'] = input.targetType;
  if (input.targetId !== undefined) updateValues['target_id'] = input.targetId;
  if (input.pair !== undefined) updateValues['pair'] = input.pair;
  if (input.timeframe !== undefined) updateValues['timeframe'] = input.timeframe;
  if (input.scheduleInterval !== undefined) updateValues['schedule_interval'] = input.scheduleInterval;
  if (input.script !== undefined) updateValues['script'] = input.script;
  if (input.params !== undefined) updateValues['params'] = JSON.stringify(input.params);
  if (input.status !== undefined) updateValues['status'] = input.status;
  if (input.isDryRun !== undefined) updateValues['is_dry_run'] = input.isDryRun;
  if (input.lastRunAt !== undefined) updateValues['last_run_at'] = input.lastRunAt;
  if (input.lastStatus !== undefined) updateValues['last_status'] = input.lastStatus;
  if (input.lastError !== undefined) updateValues['last_error'] = input.lastError;

  const row = await tdb
    .updateTable('algo_strategy')
    .set(updateValues as never)
    .where('id', '=', id as never)
    .returningAll()
    .executeTakeFirst();

  return row ? mapStrategyRow(row as unknown as Record<string, unknown>) : null;
}

/** Delete an algo strategy. */
export async function deleteAlgoStrategy(tdb: TenantDb, id: string): Promise<boolean> {
  const res = await tdb
    .deleteFrom('algo_strategy')
    .where('id', '=', id as never)
    .returning('id' as never)
    .executeTakeFirst();

  return res !== undefined;
}

/** Record a new algo run. */
export async function createAlgoRun(tdb: TenantDb, input: AlgoRunInput): Promise<AlgoRunRecord> {
  const insertValues: Record<string, unknown> = {
    strategy_id: input.strategyId,
    mode: input.mode,
    status: input.status,
    completed_at: input.completedAt ?? null,
    logs: JSON.stringify(input.logs ?? []),
    actions_taken: JSON.stringify(input.actionsTaken ?? []),
    metrics: JSON.stringify(input.metrics ?? {}),
    error: input.error ?? null,
  };

  if (input.id) {
    insertValues['id'] = input.id;
  }

  const row = await tdb
    .insertInto('algo_run', insertValues as never)
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapRunRow(row as unknown as Record<string, unknown>);
}

/** Update an ongoing or finished algo run. */
export async function updateAlgoRun(
  tdb: TenantDb,
  id: string,
  updates: Partial<AlgoRunInput>,
): Promise<void> {
  const updateValues: Record<string, unknown> = {};

  if (updates.status !== undefined) updateValues['status'] = updates.status;
  if (updates.completedAt !== undefined) updateValues['completed_at'] = updates.completedAt;
  if (updates.logs !== undefined) updateValues['logs'] = JSON.stringify(updates.logs);
  if (updates.actionsTaken !== undefined) updateValues['actions_taken'] = JSON.stringify(updates.actionsTaken);
  if (updates.metrics !== undefined) updateValues['metrics'] = JSON.stringify(updates.metrics);
  if (updates.error !== undefined) updateValues['error'] = updates.error;

  await tdb
    .updateTable('algo_run')
    .set(updateValues as never)
    .where('id', '=', id as never)
    .execute();
}

/** List execution runs for a strategy. */
export async function listAlgoRuns(
  tdb: TenantDb,
  strategyId: string,
  limit = 50,
): Promise<AlgoRunRecord[]> {
  const rows = await tdb
    .selectFrom('algo_run')
    .selectAll()
    .where('strategy_id', '=', strategyId as never)
    .orderBy('triggered_at', 'desc')
    .limit(limit)
    .execute();

  return rows.map((r) => mapRunRow(r as unknown as Record<string, unknown>));
}

/** Get a single algo run. */
export async function getAlgoRun(tdb: TenantDb, id: string): Promise<AlgoRunRecord | null> {
  const row = await tdb
    .selectFrom('algo_run')
    .selectAll()
    .where('id', '=', id as never)
    .executeTakeFirst();

  return row ? mapRunRow(row as unknown as Record<string, unknown>) : null;
}
