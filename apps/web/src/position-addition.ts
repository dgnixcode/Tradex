const SCALE = 10n ** 18n;
const decimal = (value: string | null | undefined): bigint | null => {
  if (!value || value.length > 80 || !/^\d+(?:\.\d{1,18})?$/.test(value)) return null;
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
};
const format = (value: bigint) => {
  const digits = value.toString().padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return `${digits.slice(0, -18)}${fraction ? `.${fraction}` : ''}`;
};

/** Partial exits preserve exact quantity; full exits use the separate exit action. */
export function planPositionReduction(input: {
  mode: 'percent' | 'quantity'; quantityInput: string; percent: number;
  position: { quantity: string; lockedMarginMinor: string | null };
}) {
  const invalid = { quantity: '0', remainingQuantity: input.position.quantity, marginMinor: '0', valid: false };
  const current = decimal(input.position.quantity);
  if (!current || current <= 0n) return invalid;
  let quantity: bigint | null;
  if (input.mode === 'quantity') quantity = decimal(input.quantityInput);
  else {
    if (!Number.isFinite(input.percent) || input.percent <= 0 || input.percent >= 100) return invalid;
    quantity = current * BigInt(Math.round(input.percent * 100)) / 10000n;
  }
  if (!quantity || quantity <= 0n || quantity >= current) return invalid;
  const locked = /^\d{1,80}$/.test(input.position.lockedMarginMinor ?? '') ? BigInt(input.position.lockedMarginMinor!) : 0n;
  return { quantity: format(quantity), remainingQuantity: format(current - quantity), marginMinor: String(locked * quantity / current), valid: true };
}

/** Exact request quantity and estimated margin; the server applies fresh venue rules. */
export function planPositionAddition(input: {
  mode: 'percent' | 'quantity'; quantityInput: string; percent: number; freeMinor: string | null;
  position: {
    quantity: string; lockedMarginMinor: string | null; markPrice: string | null;
    avgEntryPrice?: string | null; leverage: string | null; marginCurrency: 'INR' | 'USDT';
    settlementCurrencyAvgPrice?: string | null;
  };
}) {
  const invalid = { quantity: '0', marginMinor: '0', totalQuantity: input.position.quantity, overBudget: true, valid: false };
  const current = decimal(input.position.quantity);
  if (!current || !input.freeMinor || !/^\d{1,80}$/.test(input.freeMinor)) return invalid;
  const free = BigInt(input.freeMinor);
  const locked = /^\d{1,80}$/.test(input.position.lockedMarginMinor ?? '') ? BigInt(input.position.lockedMarginMinor!) : 0n;
  let numerator = locked, denominator = current;
  if (locked <= 0n) {
    const price = decimal(input.position.markPrice ?? input.position.avgEntryPrice);
    const leverage = decimal(input.position.leverage);
    const fx = input.position.marginCurrency === 'INR' ? decimal(input.position.settlementCurrencyAvgPrice) : SCALE;
    if (!price || !leverage || !fx) return invalid;
    numerator = price * fx * (10n ** BigInt(input.position.marginCurrency === 'INR' ? 2 : 8));
    denominator = SCALE * SCALE * leverage;
  }
  let quantity: bigint | null;
  if (input.mode === 'quantity') {
    quantity = decimal(input.quantityInput);
  } else {
    if (!Number.isFinite(input.percent) || input.percent <= 0 || input.percent > 100) return invalid;
    const target = free * BigInt(Math.round(input.percent * 100)) / 10000n;
    quantity = target * denominator / numerator;
  }
  if (!quantity || quantity <= 0n) return invalid;
  // Round estimated required margin up, never understate the funds needed.
  const margin = (quantity * numerator + denominator - 1n) / denominator;
  return { quantity: format(quantity), marginMinor: String(margin), totalQuantity: format(current + quantity), overBudget: margin > free, valid: true };
}
