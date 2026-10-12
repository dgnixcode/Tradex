/** Input validation only. The API validates native currency, fresh funds and
 * position ownership again before any transfer. No price or FX calculations. */
export function parseMarginInput(raw: string, currency: 'INR' | 'USDT') {
  const scale = currency === 'INR' ? 2 : 8;
  if (raw.length > 41 || !new RegExp(`^[+-]?\\d+(?:\\.\\d{1,${scale}})?$`).test(raw)) return null;
  const unsigned = raw.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const minor = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
  if (minor <= 0n) return null;
  const trimmedWhole = whole.replace(/^0+(?=\d)/, ''), trimmedFraction = fraction.replace(/0+$/, '');
  return { minor, amount: `${trimmedWhole}${trimmedFraction ? `.${trimmedFraction}` : ''}`, direction: raw.startsWith('-') ? 'remove' as const : 'add' as const };
}
