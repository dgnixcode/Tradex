import { useState, useEffect, useMemo } from 'react';

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}

const INITIAL_CANDLES: Candle[] = [
  { time: '10:00', open: 93400, high: 93850, low: 93200, close: 93720, vol: 184 },
  { time: '10:15', open: 93720, high: 94100, low: 93600, close: 93950, vol: 210 },
  { time: '10:30', open: 93950, high: 94250, low: 93800, close: 94180, vol: 165 },
  { time: '10:45', open: 94180, high: 94600, low: 94100, close: 94520, vol: 320 },
  { time: '11:00', open: 94520, high: 94800, low: 94350, close: 94410, vol: 195 },
  { time: '11:15', open: 94410, high: 95100, low: 94400, close: 94980, vol: 280 },
  { time: '11:30', open: 94980, high: 95350, low: 94850, close: 95220, vol: 310 },
  { time: '11:45', open: 95220, high: 95600, low: 95100, close: 95540, vol: 340 },
  { time: '12:00', open: 95540, high: 95800, low: 95300, close: 95480, vol: 220 },
  { time: '12:15', open: 95480, high: 96150, low: 95450, close: 96080, vol: 410 },
  { time: '12:30', open: 96080, high: 96420, low: 95950, close: 96350, vol: 385 },
  { time: '12:45', open: 96350, high: 96580, low: 96180, close: 96290, vol: 260 },
  { time: '13:00', open: 96290, high: 96750, low: 96220, close: 96680, vol: 430 },
  { time: '13:15', open: 96680, high: 97100, low: 96550, close: 96940, vol: 490 },
  { time: '13:30', open: 96940, high: 97320, low: 96800, close: 97180, vol: 520 },
  { time: '13:45', open: 97180, high: 97550, low: 97050, close: 97420, vol: 580 },
];

export function HeroLiveTradingChart() {
  const [candles, setCandles] = useState<Candle[]>(INITIAL_CANDLES);
  const [livePrice, setLivePrice] = useState<number>(97420);
  const [priceChange, setPriceChange] = useState<number>(4.18);
  const [isTickUp, setIsTickUp] = useState<boolean>(true);
  const [activeTf, setActiveTf] = useState<string>('15M');

  // Live real-time tick engine simulating institutional liquidity
  useEffect(() => {
    const interval = setInterval(() => {
      setLivePrice((prev) => {
        const delta = (Math.random() - 0.44) * 28; // slightly bullish bias
        const nextPrice = Math.round((prev + delta) * 10) / 10;
        const tickUp = nextPrice >= prev;
        setIsTickUp(tickUp);

        // Update latest candle
        setCandles((prevCandles) => {
          const lastIdx = prevCandles.length - 1;
          const last = prevCandles[lastIdx];
          const updated: Candle = {
            ...last,
            close: nextPrice,
            high: Math.max(last.high, nextPrice),
            low: Math.min(last.low, nextPrice),
            vol: last.vol + Math.floor(Math.random() * 3),
          };
          return [...prevCandles.slice(0, lastIdx), updated];
        });

        return nextPrice;
      });

      setPriceChange((prev) => {
        const delta = (Math.random() - 0.46) * 0.04;
        return Math.round((prev + delta) * 100) / 100;
      });
    }, 1400);

    return () => clearInterval(interval);
  }, []);

  // Compute SVG scale coordinates
  const chartMetrics = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    let maxVol = 0;

    candles.forEach((c) => {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
      if (c.vol > maxVol) maxVol = c.vol;
    });

    const padding = (max - min) * 0.08;
    const yMin = min - padding;
    const yMax = max + padding;
    const range = yMax - yMin || 1;

    return { yMin, yMax, range, maxVol };
  }, [candles]);

  const svgWidth = 560;
  const svgHeight = 260;
  const candleAreaHeight = 200;
  const volAreaHeight = 40;
  const candleCount = candles.length;
  const colWidth = svgWidth / candleCount;
  const candleBodyWidth = Math.max(colWidth * 0.62, 10);

  const getY = (val: number) => {
    const norm = (val - chartMetrics.yMin) / chartMetrics.range;
    return candleAreaHeight - norm * candleAreaHeight + 16;
  };

  // Build EMA / Trendline path
  const emaPath = useMemo(() => {
    const points = candles.map((c, i) => {
      const x = i * colWidth + colWidth / 2;
      const y = getY(c.close);
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
    });
    return points.join(' ');
  }, [candles, colWidth, chartMetrics]);

  // Build Area Gradient path beneath trend
  const areaPath = useMemo(() => {
    if (!candles.length) return '';
    const points = candles.map((c, i) => {
      const x = i * colWidth + colWidth / 2;
      const y = getY(c.close);
      return `L ${x} ${y}`;
    });
    const firstX = colWidth / 2;
    const lastX = (candles.length - 1) * colWidth + colWidth / 2;
    return `M ${firstX} ${getY(candles[0].close)} ${points.join(' ')} L ${lastX} ${candleAreaHeight + 20} L ${firstX} ${candleAreaHeight + 20} Z`;
  }, [candles, colWidth, chartMetrics]);

  const currentY = getY(livePrice);

  return (
    <div className="hero-live-terminal" aria-label="Aza WealthKare Quantitative Execution Desk">
      {/* Terminal Header */}
      <div className="terminal-header">
        <div className="terminal-header-left">
          <div className="terminal-status-pill">
            <span className="terminal-pulse-dot" />
            <span className="terminal-status-text">LIVE ALGO DESK</span>
          </div>
          <div className="terminal-pair-tag">
            <span className="pair-symbol">BTC / USDT</span>
            <span className="pair-venue">Perpetual</span>
          </div>
        </div>

        <div className="terminal-tf-selector">
          {['1M', '5M', '15M', '1H', '4H'].map((tf) => (
            <button
              key={tf}
              type="button"
              className={`terminal-tf-btn ${activeTf === tf ? 'active' : ''}`}
              onClick={() => setActiveTf(tf)}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Main Real-Time Price Strip */}
      <div className="terminal-price-strip">
        <div className="terminal-price-main">
          <span className={`terminal-big-price ${isTickUp ? 'tick-up' : 'tick-down'}`}>
            ${livePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span className="terminal-price-delta positive">
            ▲ +${(priceChange * 924.5).toFixed(2)} (+{priceChange.toFixed(2)}%)
          </span>
        </div>

        <div className="terminal-market-metrics">
          <div className="metric-col">
            <span className="metric-lbl">24H HIGH</span>
            <span className="metric-val">$97,840.00</span>
          </div>
          <div className="metric-col">
            <span className="metric-lbl">24H LOW</span>
            <span className="metric-val">$93,210.00</span>
          </div>
          <div className="metric-col hide-mobile">
            <span className="metric-lbl">EST. ALGO ALPHA</span>
            <span className="metric-val text-green">+4.2% / mo</span>
          </div>
        </div>
      </div>

      {/* Extraordinary SVG Live Candlestick & Trend Chart */}
      <div className="terminal-chart-container">
        {/* Execution Signals Overlaid in Chart */}
        <div className="chart-execution-tag buy">
          <span className="tag-icon">▲</span>
          <span>QUANT BUY FILLED $94,520</span>
        </div>

        <div className="chart-execution-tag shield">
          <span className="tag-icon">🛡️</span>
          <span>100% CAPITAL SHIELD ACTIVE</span>
        </div>

        <div className="chart-execution-tag target">
          <span className="tag-icon">🎯</span>
          <span>PROFIT TARGET $98,600 (+4.2%)</span>
        </div>

        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="terminal-svg"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="terminalAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.28" />
              <stop offset="60%" stopColor="#10b981" stopOpacity="0.06" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
            </linearGradient>

            <linearGradient id="trendLineGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#059669" />
              <stop offset="50%" stopColor="#34d399" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          <g className="chart-grid" stroke="rgba(255, 255, 255, 0.06)" strokeDasharray="3 3">
            <line x1="0" y1="50" x2={svgWidth} y2="50" />
            <line x1="0" y1="100" x2={svgWidth} y2="100" />
            <line x1="0" y1="150" x2={svgWidth} y2="150" />
            <line x1="0" y1="200" x2={svgWidth} y2="200" />
          </g>

          {/* Luminous Area Fill */}
          <path d={areaPath} fill="url(#terminalAreaGrad)" />

          {/* Golden/Cyan Trend EMA Curve */}
          <path
            d={emaPath}
            fill="none"
            stroke="url(#trendLineGrad)"
            strokeWidth="2.5"
            strokeLinecap="round"
          />

          {/* Candlesticks Sequence */}
          {candles.map((c, i) => {
            const x = i * colWidth + (colWidth - candleBodyWidth) / 2;
            const centerX = i * colWidth + colWidth / 2;
            const isBull = c.close >= c.open;
            const candleColor = isBull ? '#10b981' : '#ef4444';
            const topY = getY(Math.max(c.open, c.close));
            const botY = getY(Math.min(c.open, c.close));
            const bodyHeight = Math.max(botY - topY, 2.5);
            const highY = getY(c.high);
            const lowY = getY(c.low);

            // Volume bar at bottom
            const volNorm = c.vol / chartMetrics.maxVol;
            const volHeight = volNorm * volAreaHeight;
            const volY = svgHeight - volHeight - 6;

            return (
              <g key={c.time} className="candlestick-group">
                {/* Upper and lower wicks */}
                <line
                  x1={centerX}
                  y1={highY}
                  x2={centerX}
                  y2={lowY}
                  stroke={candleColor}
                  strokeWidth="1.5"
                  opacity="0.85"
                />

                {/* Candle body */}
                <rect
                  x={x}
                  y={topY}
                  width={candleBodyWidth}
                  height={bodyHeight}
                  fill={candleColor}
                  rx="1.5"
                />

                {/* Bottom Volume histogram bar */}
                <rect
                  x={x}
                  y={volY}
                  width={candleBodyWidth}
                  height={volHeight}
                  fill={candleColor}
                  opacity="0.22"
                  rx="1"
                />
              </g>
            );
          })}

          {/* Live Horizontal Dotted Price Guide Line */}
          <line
            x1="0"
            y1={currentY}
            x2={svgWidth}
            y2={currentY}
            stroke="#34d399"
            strokeWidth="1.2"
            strokeDasharray="4 4"
            opacity="0.8"
          />

          {/* Live Pulsing Price Dot */}
          <g transform={`translate(${svgWidth - colWidth / 2}, ${currentY})`}>
            <circle r="7" fill="#34d399" opacity="0.3" className="beacon-ring" />
            <circle r="3.5" fill="#34d399" />
          </g>
        </svg>

        {/* Live Axis Price Callout Badge */}
        <div
          className="chart-live-price-badge"
          style={{ top: `${(currentY / svgHeight) * 100}%` }}
        >
          ${livePrice.toFixed(0)}
        </div>
      </div>

      {/* Terminal Telemetry Footer Strip */}
      <div className="terminal-footer">
        <div className="terminal-telemetry-item">
          <span className="telemetry-icon">🔒</span>
          <div className="telemetry-meta">
            <span className="telemetry-label">CUSTODY MODEL</span>
            <span className="telemetry-val text-green">100% In Your Account</span>
          </div>
        </div>

        <div className="terminal-telemetry-item">
          <span className="telemetry-icon">🛡️</span>
          <div className="telemetry-meta">
            <span className="telemetry-label">PRINCIPAL RISK</span>
            <span className="telemetry-val text-cyan">Zero Deposit Risk</span>
          </div>
        </div>

        <div className="terminal-telemetry-item">
          <span className="telemetry-icon">⚡</span>
          <div className="telemetry-meta">
            <span className="telemetry-label">ALGO ALPHA</span>
            <span className="telemetry-val text-white">+3% to +5% / mo Target</span>
          </div>
        </div>
      </div>
    </div>
  );
}
