import type { TenantDb } from './tenant-scope.js';

export interface TrailingSlConfig {
  readonly accountId: string;
  readonly venuePositionId: string;
  readonly pair: string;
  readonly distanceBp: string;
  readonly stepBp: string;
  readonly highWaterMark: string;
  readonly currentSlPrice: string;
  readonly stepBasis?: 'price' | 'roe' | undefined;
  readonly stepAnchorPrice?: string | undefined;
  readonly positionBasisKey?: string | undefined;
  readonly status?: 'active' | 'failed' | undefined;
}

export async function upsertTrailingSl(
  tdb: TenantDb,
  config: TrailingSlConfig,
): Promise<void> {
  const values = {
    tenant_id: tdb.tenantId,
    account_id: config.accountId,
    venue_position_id: config.venuePositionId,
    pair: config.pair,
    distance_bp: config.distanceBp,
    step_bp: config.stepBp,
    high_water_mark: config.highWaterMark,
    current_sl_price: config.currentSlPrice,
    step_basis: config.stepBasis ?? 'price',
    step_anchor_price: config.stepBasis === 'roe' ? (config.stepAnchorPrice ?? config.highWaterMark) : null,
    position_basis_key: config.stepBasis === 'roe' ? (config.positionBasisKey ?? null) : null,
    status: config.status ?? 'active',
    last_evaluated_at: new Date(),
  };

  await tdb.insertInto('futures_trailing_sl', values)
    .onConflict((oc) => oc
      .columns(['account_id', 'venue_position_id'])
      .doUpdateSet({
        distance_bp: config.distanceBp,
        step_bp: config.stepBp,
        high_water_mark: config.highWaterMark,
        current_sl_price: config.currentSlPrice,
        step_basis: values.step_basis,
        step_anchor_price: values.step_anchor_price,
        position_basis_key: values.position_basis_key,
        status: values.status,
        last_evaluated_at: new Date(),
      } as never)
    )
    .execute();
}

export async function clearTrailingSl(
  tdb: TenantDb,
  accountId: string,
  venuePositionId: string,
): Promise<void> {
  await tdb.deleteFrom('futures_trailing_sl')
    .where('account_id' as never, '=', accountId as never)
    .where('venue_position_id' as never, '=', venuePositionId as never)
    .execute();
}
