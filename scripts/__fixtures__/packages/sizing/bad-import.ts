// FIXTURE: deliberately violates SIZING-IMPORT-ALLOWLIST. Not compiled, not shipped.
//
// This is the transitive hole SIZING-PURE-NO-IO cannot see: not one banned token
// appears here, yet importing a package that talks to a database makes sizing
// impure all the same. The allowlist is what closes it.
import { forTenant } from '@tradex/db';
import { CoinDcxAdapter } from '@tradex/exchange-coindcx';

export const reachedOutward = [forTenant, CoinDcxAdapter];
