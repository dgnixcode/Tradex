// Migration script to backfill exact CoinDCX filled exit orders for SOLUSDT positions
// from September 19, 2026 into group_trade and child_order.
import pg from 'pg';

const sells = [
  { accountId: '2afd801e-07a1-4eaa-96d7-f6c47811e1fb', venueOrderId: '5ca9a61f-a885-4c56-9556-c3772bdefff5', qty: '0.35', price: '111.54', at: '2026-09-19T13:40:13.675Z' },
  { accountId: '3af51935-1024-4515-8cc5-acb2289ef850', venueOrderId: '69fdfbb3-8996-42f5-8757-3743066ae513', qty: '0.21', price: '111.52', at: '2026-09-19T13:38:58.252Z' },
  { accountId: '4a157f0f-9fe9-4717-84fb-fc62086ffcde', venueOrderId: '8dede18c-4231-482c-b7ca-1e93dcc65a5c', qty: '1.08', price: '111.53', at: '2026-09-19T13:39:52.052Z' },
  { accountId: '5c6d6b25-a28e-4fa7-9890-b0913a48872a', venueOrderId: '9e4b1dc0-665c-4328-b089-8689342b2285', qty: '0.1', price: '111.54', at: '2026-09-19T13:40:08.355Z' },
  { accountId: '62cc88f1-ede1-4c61-8a07-0d7a39a0064d', venueOrderId: '308ba314-8974-4c3d-8294-831c800dbb1d', qty: '2.85', price: '111.56', at: '2026-09-19T13:39:57.733Z' },
  { accountId: '6f539ba3-3fe5-4961-b817-6309ca8fd517', venueOrderId: '7d704b35-776e-4678-aaa0-3f79e298c2cc', qty: '0.94', price: '111.54', at: '2026-09-19T13:40:00.368Z' },
  { accountId: '875ab708-6e56-46c0-8666-273d870f0b58', venueOrderId: '61525124-d530-4b0c-b2ad-df8e0e9afd78', qty: '0.41', price: '111.54', at: '2026-09-19T13:40:05.516Z' },
  { accountId: 'a2b124ce-26b0-40b8-b813-dcaff01ea609', venueOrderId: '03218272-78ba-433d-a2e1-42809f3d72fc', qty: '0.44', price: '111.54', at: '2026-09-19T13:40:11.044Z' },
  { accountId: 'da138d7b-1315-4444-873e-35fc6666d8f2', venueOrderId: '60208022-a840-4035-a4f6-702276684da2', qty: '1.67', price: '111.54', at: '2026-09-19T13:40:03.021Z' },
  { accountId: 'ded2c588-4c47-4bb9-aa19-98844797c0d1', venueOrderId: '2f291680-6941-41f4-95db-1ff3e9121713', qty: '0.4', price: '111.54', at: '2026-09-19T13:39:55.061Z' },
  { accountId: 'edc5606a-c7f0-4b75-8250-73ede2e97116', venueOrderId: '57c98012-8063-460a-bb5d-c997df78152d', qty: '0.44', price: '111.55', at: '2026-09-19T13:40:18.767Z' },
  { accountId: 'fd8a6eb6-7285-4712-9bca-2b6f878fc30c', venueOrderId: '1313ea6b-eedd-45ab-9b00-850d8572af56', qty: '0.52', price: '111.55', at: '2026-09-19T13:40:16.258Z' },
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');

    const gtId = 'c01ddcx-sol-exit-20260919';
    const gtCheck = await client.query('SELECT id FROM group_trade WHERE id = $1', [gtId]);
    if (gtCheck.rows.length === 0) {
      await client.query(
        `INSERT INTO group_trade (
          id, tenant_id, group_id, created_by, asset, side, order_type,
          sizing_mode, sizing_value, status, preview_token, preview_expires_at,
          dry_run, send_suppressed, is_futures, leverage, margin_currency,
          quote_currency, position_margin_type, reduce_only, trailing_stop_loss,
          created_at, submitted_at, completed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24
        )`,
        [
          gtId,
          '577e3e00-dc5d-4a39-8fec-2514e5df573f',
          '87ff90f5-59a1-43b2-a7d5-152390965e92',
          '09524cdd-89d1-4862-9a56-903526b3eed3',
          'SOL',
          'sell',
          'market',
          'sell_all',
          null,
          'completed',
          'direct-' + gtId,
          '2026-09-20T13:40:00.000Z',
          false,
          false,
          true,
          '5',
          'INR',
          'USDT',
          'isolated',
          true,
          false,
          '2026-09-19T13:40:00.000Z',
          '2026-09-19T13:40:00.000Z',
          '2026-09-19T13:40:19.415Z',
        ],
      );
      console.log('Inserted group_trade ' + gtId);
    } else {
      console.log('group_trade ' + gtId + ' already exists');
    }

    let inserted = 0;
    for (const s of sells) {
      const coCheck = await client.query(
        'SELECT id FROM child_order WHERE exchange_order_id = $1',
        [s.venueOrderId],
      );
      if (coCheck.rows.length === 0) {
        const notionalMinor = Math.round(Number(s.qty) * Number(s.price) * 100 * 100).toString();
        await client.query(
          `INSERT INTO child_order (
            tenant_id, group_trade_id, account_id, leg_seq, market, pair,
            quote_currency, price_used, avg_fill_price, final_quantity,
            filled_quantity, state, leg_kind, exchange_order_id,
            notional_minor, sent_at, terminal_at, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17, $18
          )`,
          [
            '577e3e00-dc5d-4a39-8fec-2514e5df573f',
            gtId,
            s.accountId,
            0,
            'SOLUSDT',
            'B-SOL_USDT',
            'USDT',
            s.price,
            s.price,
            s.qty,
            s.qty,
            'filled',
            'exit',
            s.venueOrderId,
            notionalMinor,
            s.at,
            s.at,
            s.at,
          ],
        );
        inserted++;
      }
    }
    console.log('Successfully backfilled ' + inserted + ' exit child orders');

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Backfill error:', err);
  process.exit(1);
});
