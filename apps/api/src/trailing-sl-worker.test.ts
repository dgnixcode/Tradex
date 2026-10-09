import { describe, expect, it } from 'vitest';
import { trailingTarget } from './trailing-sl-worker.js';
import { marginInrMinor } from './futures/risk-reservation.js';

describe('exact trailing and risk arithmetic', () => {
  const config = { live: '110', extreme: '100', current: '95', short: false, distanceBp: '500', stepBp: '100', tick: '0.5' };
  it('advances a long stop on the venue tick', () => expect(trailingTarget(config)).toEqual({ extreme: '110', stop: '104.5' }));
  it('advances a short stop downward and rounds upward to the tick', () => {
    expect(trailingTarget({ ...config, short: true, live: '90.1', current: '105' })).toEqual({ extreme: '90.1', stop: '95' });
  });
  it('never loosens a stop when the price reverses', () => {
    expect(trailingTarget({ ...config, live: '98', current: '99' }).stop).toBeNull();
    expect(trailingTarget({ ...config, short: true, live: '110', current: '104' }).stop).toBeNull();
  });
  it('does not round a stop across the live price', () => expect(trailingTarget({ ...config, live: '1', extreme: '1', current: '0.5', tick: '2' }).stop).toBeNull());
  it('keeps precision for prices too large for Number', () => {
    const result = trailingTarget({ ...config, live: '9007199254740993.123456789', extreme: '9007199254740992', current: '1', tick: '0.000000001' });
    expect(result.stop).toBe('8556839292003943.467283949');
  });
  it('checks margin caps in INR rather than mixing quote currencies', () => {
    expect(marginInrMinor('0.01', '60000', 10, 'USDT', '80')).toBe('480000');
    expect(marginInrMinor('0.01', '4800000', 10, 'INR', '80')).toBe('480000');
    expect(marginInrMinor('0.00001', '0.0001', 100, 'USDT', '80')).toBe('1');
    expect(() => marginInrMinor('1', '1', 10, 'USDT', '0')).toThrow();
  });
});
