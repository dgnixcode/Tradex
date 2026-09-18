import { useEffect, useRef, useState, memo } from 'react';

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

interface SingleChartProps {
  readonly symbol: string;
  readonly theme: 'dark' | 'light';
  readonly visible: boolean;
}

const SingleTradingViewChart = memo(function SingleTradingViewChart({
  symbol,
  theme,
  visible,
}: SingleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || initializedRef.current) return;
    initializedRef.current = true;

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
      enable_publishing: false,
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
  }, [symbol, theme]);

  // When toggling back to visible, trigger window resize so TradingView canvas recalculates dimensions
  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 50);
      return () => clearTimeout(t);
    }
  }, [visible]);

  return (
    <div
      ref={containerRef}
      style={{
        display: visible ? 'block' : 'none',
        height: '100%',
        width: '100%',
        position: 'absolute',
        top: 0,
        left: 0,
      }}
    />
  );
});

const MAX_CACHED_CHARTS = 10;

export const TradingViewChart = memo(function TradingViewChart({
  asset,
  quoteCurrency = 'USDT',
  theme = 'dark',
  height = '100%',
}: TradingViewChartProps) {
  const symbol = resolveTradingViewSymbol(asset, quoteCurrency);

  // Keep an MRU (Most Recently Used) list of loaded chart symbols.
  // Inactive charts are hidden via `display: none` rather than destroyed,
  // preserving user drawings, trendlines, indicators, and zoom levels across coin & tab switches.
  const [cachedSymbols, setCachedSymbols] = useState<string[]>(() => [symbol]);

  useEffect(() => {
    setCachedSymbols((prev) => {
      if (prev.includes(symbol)) {
        // Move to the end (most recent)
        return [...prev.filter((s) => s !== symbol), symbol];
      }
      // Add new symbol; if cache exceeds limit, drop the oldest unused one
      const updated = [...prev, symbol];
      if (updated.length > MAX_CACHED_CHARTS) {
        return updated.slice(updated.length - MAX_CACHED_CHARTS);
      }
      return updated;
    });
  }, [symbol]);

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
      {cachedSymbols.map((s) => (
        <SingleTradingViewChart
          key={`${s}_${theme}`}
          symbol={s}
          theme={theme}
          visible={s === symbol}
        />
      ))}
    </div>
  );
});
