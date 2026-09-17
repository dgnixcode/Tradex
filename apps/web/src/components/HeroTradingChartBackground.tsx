import { useState, useEffect, useMemo } from 'react';

interface BackgroundCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}

const BASE_CANDLES: BackgroundCandle[] = [
  { open: 93100, high: 93450, low: 92950, close: 93380, vol: 190 },
  { open: 93380, high: 93700, low: 93220, close: 93550, vol: 220 },
  { open: 93550, high: 93820, low: 93400, close: 93780, vol: 240 },
  { open: 93780, high: 93950, low: 93500, close: 93620, vol: 180 },
  { open: 93620, high: 94150, low: 93580, close: 94050, vol: 310 },
  { open: 94050, high: 94380, low: 93900, close: 94280, vol: 275 },
  { open: 94280, high: 94500, low: 94120, close: 94450, vol: 290 },
  { open: 94450, high: 94720, low: 94300, close: 94600, vol: 330 },
  { open: 94600, high: 94800, low: 94380, close: 94480, vol: 210 },
  { open: 94480, high: 94950, low: 94420, close: 94880, vol: 350 },
  { open: 94880, high: 95200, low: 94750, close: 95120, vol: 380 },
  { open: 95120, high: 95400, low: 95000, close: 95350, vol: 410 },
  { open: 95350, high: 95650, low: 95200, close: 95580, vol: 440 },
  { open: 95580, high: 95700, low: 95320, close: 95450, vol: 230 },
  { open: 95450, high: 95950, low: 95400, close: 95880, vol: 470 },
  { open: 95880, high: 96250, low: 95800, close: 96180, vol: 510 },
  { open: 96180, high: 96400, low: 96000, close: 96320, vol: 430 },
  { open: 96320, high: 96550, low: 96150, close: 96250, vol: 260 },
  { open: 96250, high: 96780, low: 96200, close: 96690, vol: 540 },
  { open: 96690, high: 97050, low: 96600, close: 96980, vol: 580 },
  { open: 96980, high: 97220, low: 96850, close: 97150, vol: 490 },
  { open: 97150, high: 97350, low: 96920, close: 97080, vol: 290 },
  { open: 97080, high: 97500, low: 97020, close: 97420, vol: 610 },
  { open: 97420, high: 97750, low: 97350, close: 97680, vol: 640 },
  { open: 97680, high: 97920, low: 97500, close: 97850, vol: 590 },
  { open: 97850, high: 98100, low: 97720, close: 98020, vol: 680 },
  { open: 98020, high: 98250, low: 97880, close: 97980, vol: 320 },
  { open: 97980, high: 98400, low: 97920, close: 98320, vol: 720 },
  { open: 98320, high: 98650, low: 98250, close: 98580, vol: 790 },
  { open: 98580, high: 98850, low: 98450, close: 98720, vol: 810 },
  { open: 98720, high: 98900, low: 98520, close: 98650, vol: 360 },
  { open: 98650, high: 99120, low: 98600, close: 99050, vol: 860 },
  { open: 99050, high: 99350, low: 98950, close: 99280, vol: 910 },
  { open: 99280, high: 99520, low: 99180, close: 99450, vol: 870 },
  { open: 99450, high: 99650, low: 99300, close: 99400, vol: 420 },
  { open: 99400, high: 99820, low: 99350, close: 99750, vol: 950 },
  { open: 99750, high: 100150, low: 99680, close: 100080, vol: 1040 },
  { open: 100080, high: 100380, low: 99950, close: 100240, vol: 980 },
];

export function HeroTradingChartBackground() {
  const [candles, setCandles] = useState<BackgroundCandle[]>(BASE_CANDLES);
  const [livePrice, setLivePrice] = useState<number>(100240);
  const [isTickUp, setIsTickUp] = useState<boolean>(true);
  const [alphaDelta, setAlphaDelta] = useState<number>(4.62);

  // Dynamic live micro-tick engine simulating live institutional trades
  useEffect(() => {
    const interval = setInterval(() => {
      setLivePrice((prev) => {
        const delta = (Math.random() - 0.44) * 24;
        const next = Math.round((prev + delta) * 10) / 10;
        setIsTickUp(next >= prev);

        setCandles((prevCandles) => {
          const lastIdx = prevCandles.length - 1;
          const last = prevCandles[lastIdx];
          const updated: BackgroundCandle = {
            ...last,
            close: next,
            high: Math.max(last.high, next),
            low: Math.min(last.low, next),
            vol: last.vol + Math.floor(Math.random() * 4),
          };
          return [...prevCandles.slice(0, lastIdx), updated];
        });

        return next;
      });

      setAlphaDelta((prev) => {
        const delta = (Math.random() - 0.47) * 0.02;
        return Math.round((prev + delta) * 100) / 100;
      });
    }, 1200);

    return () => clearInterval(interval);
  }, []);

  // Coordinate geometry for SVG canvas (1440 x 680)
  const svgWidth = 1440;
  const svgHeight = 680;
  const chartTop = 80;
  const chartHeight = 460;
  const chartBottom = chartTop + chartHeight;
  const volHeight = 70;
  const volBottom = svgHeight - 20;

  const { yMin, yRange, maxVol } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    let mv = 0;
    candles.forEach((c) => {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
      if (c.vol > mv) mv = c.vol;
    });
    const pad = (max - min) * 0.08;
    return {
      yMin: min - pad,
      yMax: max + pad,
      yRange: (max + pad) - (min - pad) || 1,
      maxVol: mv || 1,
    };
  }, [candles]);

  const getY = (val: number) => {
    const norm = (val - yMin) / yRange;
    return chartBottom - norm * chartHeight;
  };

  const candleCount = candles.length;
  const colWidth = svgWidth / candleCount;
  const bodyWidth = Math.max(colWidth * 0.58, 12);

  // Fast EMA (20-period lookback curve)
  const emaPath = useMemo(() => {
    return candles
      .map((c, i) => {
        const x = i * colWidth + colWidth / 2;
        const y = getY(c.close);
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [candles, colWidth, yMin, yRange]);

  // Slow EMA (trend confirmation curve)
  const slowEmaPath = useMemo(() => {
    return candles
      .map((c, i) => {
        const x = i * colWidth + colWidth / 2;
        const smoothed = c.open * 0.6 + c.close * 0.4 - 380;
        const y = getY(smoothed);
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }, [candles, colWidth, yMin, yRange]);

  // Translucent glowing area under fast EMA
  const areaPath = useMemo(() => {
    if (!candles.length) return '';
    const points = candles
      .map((c, i) => {
        const x = i * colWidth + colWidth / 2;
        const y = getY(c.close);
        return `L ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
    const firstX = (colWidth / 2).toFixed(1);
    const lastX = ((candles.length - 1) * colWidth + colWidth / 2).toFixed(1);
    return `M ${firstX} ${getY(candles[0].close).toFixed(1)} ${points} L ${lastX} ${chartBottom} L ${firstX} ${chartBottom} Z`;
  }, [candles, colWidth, yMin, yRange]);

  const currentY = getY(livePrice);
  const gridLevels = [93500, 95000, 96500, 98000, 99500];

  return (
    <div className="hero-chart-bg-layer" aria-hidden="true">
      {/* Sleek Top Ticker Watermark Ribbon */}
      <div className="hero-chart-ticker-ribbon">
        <div className="ticker-ribbon-item">
          <span className="ticker-live-beacon" />
          <span className="ticker-text-primary">LIVE QUANTITATIVE DESK</span>
        </div>
        <div className="ticker-ribbon-sep">/</div>
        <div className="ticker-ribbon-item">
          <span className="ticker-muted">PAIR:</span>
          <span className="ticker-val">BTC/USDT PERP</span>
        </div>
        <div className="ticker-ribbon-sep">/</div>
        <div className="ticker-ribbon-item">
          <span className="ticker-muted">PRICE:</span>
          <span className={`ticker-val ${isTickUp ? 'text-green' : 'text-red'}`}>
            ${livePrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
          <span className="ticker-delta text-green">(+{alphaDelta}%)</span>
        </div>
        <div className="ticker-ribbon-sep hide-mobile">/</div>
        <div className="ticker-ribbon-item hide-mobile">
          <span className="ticker-muted">LATENCY:</span>
          <span className="ticker-val text-cyan">11.4ms</span>
        </div>
        <div className="ticker-ribbon-sep hide-mobile">/</div>
        <div className="ticker-ribbon-item hide-mobile">
          <span className="ticker-muted">CUSTODY:</span>
          <span className="ticker-val text-green">100% IN YOUR ACCOUNT</span>
        </div>
      </div>

      {/* Full-Bleed SVG Quantitative Trading Canvas */}
      <svg
        className="hero-chart-svg"
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        preserveAspectRatio="none"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <filter id="bgEmeraldGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="7" result="blur1" />
            <feGaussianBlur stdDeviation="2" result="blur2" />
            <feMerge>
              <feMergeNode in="blur1" />
              <feMergeNode in="blur2" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <filter id="bgLaserGlow" x="-10%" y="-30%" width="120%" height="160%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <linearGradient id="bgAreaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.24" />
            <stop offset="60%" stopColor="#10b981" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
          </linearGradient>

          <linearGradient id="bgCandleGreen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" />
            <stop offset="100%" stopColor="#059669" />
          </linearGradient>

          <linearGradient id="bgCandleRed" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fb7185" />
            <stop offset="100%" stopColor="#e11d48" />
          </linearGradient>
        </defs>

        <g className="chart-grid">
          {gridLevels.map((lvl) => {
            const y = getY(lvl);
            return (
              <g key={lvl}>
                <line
                  x1="0"
                  y1={y}
                  x2={svgWidth}
                  y2={y}
                  stroke="rgba(52, 211, 153, 0.12)"
                  strokeDasharray="4 8"
                  strokeWidth="1"
                />
                <text
                  x={svgWidth - 14}
                  y={y - 5}
                  textAnchor="end"
                  fill="rgba(52, 211, 153, 0.45)"
                  fontSize="11"
                  fontFamily="var(--mono, monospace)"
                  fontWeight="600"
                >
                  ${lvl.toLocaleString()} USDT
                </text>
              </g>
            );
          })}

          {[160, 360, 560, 760, 960, 1160, 1340].map((vx) => (
            <line
              key={vx}
              x1={vx}
              y1={chartTop}
              x2={vx}
              y2={chartBottom + volHeight}
              stroke="rgba(255, 255, 255, 0.04)"
              strokeDasharray="2 6"
              strokeWidth="1"
            />
          ))}
        </g>

        <path d={areaPath} fill="url(#bgAreaGradient)" />

        <path
          d={slowEmaPath}
          stroke="#f59e0b"
          strokeWidth="1.8"
          strokeDasharray="5 3"
          strokeOpacity="0.65"
          fill="none"
        />

        <path
          d={emaPath}
          stroke="#34d399"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#bgEmeraldGlow)"
          fill="none"
        />

        <g className="chart-volume-bars">
          {candles.map((c, idx) => {
            const isGreen = c.close >= c.open;
            const x = idx * colWidth + (colWidth - bodyWidth) / 2;
            const h = (c.vol / maxVol) * volHeight;
            const y = volBottom - h;
            return (
              <rect
                key={`vol-${idx}`}
                x={x}
                y={y}
                width={bodyWidth}
                height={h}
                fill={isGreen ? '#10b981' : '#f43f5e'}
                opacity={isGreen ? 0.38 : 0.24}
                rx="2"
              />
            );
          })}
        </g>

        <g className="chart-candlesticks">
          {candles.map((c, idx) => {
            const isGreen = c.close >= c.open;
            const xCenter = idx * colWidth + colWidth / 2;
            const xLeft = idx * colWidth + (colWidth - bodyWidth) / 2;
            const yHigh = getY(c.high);
            const yLow = getY(c.low);
            const yTop = getY(Math.max(c.open, c.close));
            const yBottom = getY(Math.min(c.open, c.close));
            const bodyHeight = Math.max(yBottom - yTop, 3);
            const isLast = idx === candles.length - 1;

            return (
              <g key={`candle-${idx}`} className={isLast ? 'live-active-candle' : undefined}>
                <line
                  x1={xCenter}
                  y1={yHigh}
                  x2={xCenter}
                  y2={yLow}
                  stroke={isGreen ? '#34d399' : '#f87171'}
                  strokeWidth="1.6"
                  opacity={isLast ? 1 : 0.85}
                />
                <rect
                  x={xLeft}
                  y={yTop}
                  width={bodyWidth}
                  height={bodyHeight}
                  fill={isGreen ? 'url(#bgCandleGreen)' : 'url(#bgCandleRed)'}
                  stroke={isGreen ? '#34d399' : '#f87171'}
                  strokeWidth="1"
                  rx="3"
                  filter={isGreen ? 'url(#bgEmeraldGlow)' : undefined}
                />
              </g>
            );
          })}
        </g>

        <g className="live-price-laser">
          <line
            x1="0"
            y1={currentY}
            x2={svgWidth}
            y2={currentY}
            stroke="#10b981"
            strokeWidth="1.8"
            strokeDasharray="6 4"
            filter="url(#bgLaserGlow)"
            opacity="0.85"
          />

          <circle
            cx={(candles.length - 1) * colWidth + colWidth / 2}
            cy={currentY}
            r="8"
            fill="#34d399"
            fillOpacity="0.3"
            className="beacon-ring"
          />
          <circle
            cx={(candles.length - 1) * colWidth + colWidth / 2}
            cy={currentY}
            r="4.5"
            fill="#ffffff"
            stroke="#10b981"
            strokeWidth="2"
          />

          <g transform={`translate(${svgWidth - 148}, ${currentY - 14})`}>
            <rect
              width="140"
              height="28"
              rx="6"
              fill="#064e3b"
              stroke="#34d399"
              strokeWidth="1.5"
              filter="url(#bgEmeraldGlow)"
            />
            <text
              x="70"
              y="18"
              textAnchor="middle"
              fill="#ffffff"
              fontSize="12.5"
              fontFamily="var(--mono, monospace)"
              fontWeight="850"
            >
              ${livePrice.toLocaleString('en-US', { minimumFractionDigits: 1 })}
            </text>
          </g>
        </g>

        <g transform={`translate(${11 * colWidth}, ${getY(95120) - 42})`}>
          <rect
            width="158"
            height="26"
            rx="6"
            fill="rgba(6, 78, 59, 0.92)"
            stroke="#10b981"
            strokeWidth="1.2"
          />
          <text
            x="79"
            y="17"
            textAnchor="middle"
            fill="#a7f3d0"
            fontSize="10.5"
            fontFamily="var(--mono, monospace)"
            fontWeight="750"
          >
            ▲ QUANT BUY @ $94,880
          </text>
        </g>

        <g transform={`translate(${21 * colWidth}, ${getY(97150) + 18})`}>
          <rect
            width="170"
            height="26"
            rx="6"
            fill="rgba(12, 74, 110, 0.92)"
            stroke="#0284c7"
            strokeWidth="1.2"
          />
          <text
            x="85"
            y="17"
            textAnchor="middle"
            fill="#bae6fd"
            fontSize="10.5"
            fontFamily="var(--mono, monospace)"
            fontWeight="750"
          >
            🛡️ 100% CAPITAL SHIELD
          </text>
        </g>

        <g transform={`translate(${31 * colWidth}, ${getY(99280) - 42})`}>
          <rect
            width="178"
            height="26"
            rx="6"
            fill="rgba(19, 78, 74, 0.92)"
            stroke="#14b8a6"
            strokeWidth="1.2"
          />
          <text
            x="89"
            y="17"
            textAnchor="middle"
            fill="#99f6e4"
            fontSize="10.5"
            fontFamily="var(--mono, monospace)"
            fontWeight="750"
          >
            🎯 PROFIT TARGET: +4.8%
          </text>
        </g>
      </svg>

      <div className="hero-chart-vignette-left" />
      <div className="hero-chart-vignette-bottom" />
    </div>
  );
}
