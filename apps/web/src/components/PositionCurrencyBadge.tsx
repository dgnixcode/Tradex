export function PositionCurrencyBadge({ currency }: { currency: 'INR' | 'USDT' }) {
  return <span className={`position-currency-badge currency-${currency.toLowerCase()}`} title={`Margin and P&L in ${currency}`}>
    {currency === 'INR' && <span aria-hidden="true">₹</span>} {currency}
  </span>;
}
