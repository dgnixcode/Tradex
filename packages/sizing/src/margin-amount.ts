/** Exact native-currency margin amount. Never convert the request to leverage. */
export function parseMarginAmount(amount: string, currency: 'INR' | 'USDT') {
  const scale = currency === 'INR' ? 2 : 8;
  if (typeof amount !== 'string' || amount.length > 40
    || !new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`).test(amount)) {
    throw new Error(`Enter a positive ${currency} amount with at most ${scale} decimal places`);
  }
  const [whole = '0', fraction = ''] = amount.split('.');
  const minor = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
  if (minor <= 0n) throw new Error('Margin amount must be greater than zero');
  const majorWhole = (minor / 10n ** BigInt(scale)).toString();
  const majorFraction = (minor % 10n ** BigInt(scale)).toString().padStart(scale, '0').replace(/0+$/, '');
  return { minor, amount: majorFraction ? `${majorWhole}.${majorFraction}` : majorWhole };
}
