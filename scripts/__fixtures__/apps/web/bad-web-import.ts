// WEB-NO-MONEY-MODULE fixture: a component importing a money module at runtime.
// The web app must never compute money — screens render metric/report objects.
import { addMinor } from '@tradex/money';

export const total = addMinor('1', '2');
