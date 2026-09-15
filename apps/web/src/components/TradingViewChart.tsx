import { useEffect, useRef, memo } from 'react';

interface TradingViewChartProps {
  readonly asset: string;
  readonly quoteCurrency?: string;
  readonly theme?: 'dark' | 'light';
  readonly height?: number | string;
}

/**
 * Maps the platform asset + quote to a valid TradingView exchange symbol.
 * Defaults to Binance for USDT futures (deepest real-time liquidity and 0-delay feeds),
 * or CoinDCX for INR spot/futures.
 */
function resolveTradingViewSymbol(asset: string, quote = 'USDT'): string {
  const cleanAsset = (asset || 'BTC').toUpperCase().trim();
  const cleanQuote = (quote || 'USDT').toUpperCase().trim();

  if (cleanQuote === 'INR') {
    return `COINDCX:${cleanAsset}INR`;
  }
  return `BINANCE:${cleanAsset}USDT`;
}

export const TradingViewChart = memo(function TradingViewChart({
  asset,
  quoteCurrency = 'USDT',
  theme = 'dark',
  height = '100%',
}: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const symbol = resolveTradingViewSymbol(asset, quoteCurrency);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Official TradingView Advanced Chart DOM structure
    container.innerHTML = `
      <div class="tradingview-widget-container" style="height: 100%; width: 100%;">
        <div class="tradingview-widget-container__widget" style="height: 100%; width: 100%;"></div>
      </div>
    `;

    const widgetDiv = container.querySelector('.tradingview-widget-container');
    if (!widgetDiv) return;

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval: '15',
      timezone: 'Etc/UTC',
      theme,
      style: '1', // Candlestick
      locale: 'en',
      enable_publishing: true,
      allow_symbol_change: true,
      calendar: false,
      support_host: 'https://www.tradingview.com',
      hide_side_toolbar: false,
      hide_top_toolbar: false,
      withdateranges: true,
      save_image: true,
      show_popup_button: false,
    });

    widgetDiv.appendChild(script);

    return () => {
      if (container) {
        container.innerHTML = '';
      }
    };
  }, [symbol, theme]);

  return (
    <div
      className="tv-chart-wrapper"
      style={{
        position: 'relative',
        width: '100%',
        height,
        overflow: 'hidden',
        background: '#000000',
        border: 'none',
      }}
    >
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  );
});
