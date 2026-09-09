// client_order_id derivation — plan/phase-06 T06.2.
//
// The idempotency key we send to the exchange with every order. It must be
// DETERMINISTIC — derivable again from the row after a crash or an ambiguous
// send — because that is what lets a resolve call ask "did order <coid> land?"
// and get an unambiguous answer (08 F6, X1). So it is a function of the trade
// leg's own identity, not of a counter or the clock:
//
//   "t" + base32(HMAC-SHA256(pepper, groupTradeId‖accountId‖legSeq))[0..27]
//
// 27 characters of base32 is 135 bits of keyed digest — far beyond any collision
// risk for one tenant's legs, and comfortably inside the venue's 36-character
// limit. The HMAC pepper means an attacker who can read the database cannot forge
// a collision with a live order's id.
//
// The id is reserved in the same transaction that writes the child to `sending`
// (write-before-send, T06.3), and `UNIQUE (client_order_id)` on child_order makes
// a duplicate insert — a re-send racing a crash — fail before any HTTP call.

import { createHmac } from 'node:crypto';
import { base32Encode } from '@tradex/auth';

/** How many base32 characters we keep: 135 bits of a keyed HMAC. */
const COID_CHARS = 27;
export const CLIENT_ORDER_ID_PREFIX = 't';

export class ClientOrderIdError extends Error {
  override readonly name = 'ClientOrderIdError';
}

/**
 * Derive the deterministic client order id for one leg of a group trade.
 *
 * `legSeq` is the leg within the trade (v1 sends one leg per account, so it is
 * almost always 0); the triple is enough to make every id in a tenant unique
 * while still being reproducible from the row alone.
 */
export function clientOrderIdOf(
  pepper: Uint8Array,
  groupTradeId: string,
  accountId: string,
  legSeq: number,
): string {
  if (pepper.byteLength < 16) throw new ClientOrderIdError('the coid pepper must be at least 16 bytes');
  if (groupTradeId === '' || accountId === '') {
    throw new ClientOrderIdError('a client order id needs both the trade and the account');
  }
  if (!Number.isInteger(legSeq) || legSeq < 0) {
    throw new ClientOrderIdError(`legSeq must be a non-negative integer, got ${String(legSeq)}`);
  }
  const mac = createHmac('sha256', Buffer.from(pepper))
    .update(`${groupTradeId}‖${accountId}‖${legSeq}`, 'utf8')
    .digest();
  const b32 = base32Encode(mac);
  return `${CLIENT_ORDER_ID_PREFIX}${b32.slice(0, COID_CHARS).toLowerCase()}`;
}
