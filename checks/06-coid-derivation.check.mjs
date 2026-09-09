// 06-coid-derivation — plan/phase-06 T06.2.
//
// client_order_id is the idempotency key sent to the exchange. It must be
// deterministic (same row → same id, so a crash or ambiguous send can be resolved
// by asking the venue about the SAME id), inside the 36-char limit, and stable
// per (trade, account, leg). Pure — no DB needed.

import { clientOrderIdOf, CLIENT_ORDER_ID_PREFIX } from '../packages/crypto/dist/index.js';

const PEPPER = Buffer.from('cf'.repeat(16), 'hex');
const GT = '11111111-1111-1111-1111-111111111111';
const ACCT = '22222222-2222-2222-2222-222222222222';
const LEG = 0;

export async function run(assert) {
  const id = clientOrderIdOf(PEPPER, GT, ACCT, LEG);

  // Determinism: same inputs, same id, every time.
  assert(id === clientOrderIdOf(PEPPER, GT, ACCT, LEG), 'the same leg must derive the same id');
  assert(id === clientOrderIdOf(Buffer.from(PEPPER), GT, ACCT, LEG), 'pepper as a Buffer must give the same id');

  // Inside the venue limit, with the documented shape.
  assert(id.length <= 36, `the id must be ≤ 36 chars, got ${id.length}`);
  assert(id.startsWith(CLIENT_ORDER_ID_PREFIX), `the id must start with '${CLIENT_ORDER_ID_PREFIX}'`);
  assert(/^t[a-z2-7]{27}$/.test(id), `the id must be t + 27 base32 chars, got ${id}`);

  // Distinctness: any input change → a different id.
  assert(clientOrderIdOf(PEPPER, GT, ACCT, LEG) !== clientOrderIdOf(PEPPER, GT, ACCT, LEG + 1),
    'a different leg must give a different id');
  assert(clientOrderIdOf(PEPPER, GT, ACCT, LEG) !== clientOrderIdOf(PEPPER, GT, `${ACCT}9`, LEG),
    'a different account must give a different id');
  assert(clientOrderIdOf(PEPPER, GT, ACCT, LEG) !== clientOrderIdOf(PEPPER, `${GT}9`, ACCT, LEG),
    'a different trade must give a different id');
  assert(clientOrderIdOf(Buffer.alloc(16, 9), GT, ACCT, LEG) !== id,
    'a different pepper must give a different id (attacker cannot forge a collision)');

  // Two legs of the same trade+account never collide across many tries.
  const seen = new Set();
  let collisions = 0;
  for (let leg = 0; leg < 500; leg += 1) {
    const v = clientOrderIdOf(PEPPER, GT, ACCT, leg);
    if (seen.has(v)) collisions += 1;
    seen.add(v);
  }
  assert(collisions === 0, '500 legs of one trade+account collided');

  // A short pepper is refused, so a weak deployment fails loudly.
  let refused = false;
  try { clientOrderIdOf(Buffer.alloc(8), GT, ACCT, LEG); } catch { refused = true; }
  assert(refused, 'a pepper under 16 bytes must be refused');
}
