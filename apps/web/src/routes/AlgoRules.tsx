import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';

export const ALGO_AI_SYSTEM_PROMPT = `You are an expert algorithmic trading engineer writing strategy scripts for the Aza WealthKare platform.
Follow these mandatory platform rules:

1. RUNTIME ENVIRONMENT:
   - Scripts run inside a secure, sandboxed Node.js VM.
   - Do NOT use \`require()\`, external \`import\` statements, or raw \`fetch()\`.
   - All standard JavaScript built-ins (Math, Array, Object, Date, JSON, Promise) are available.
   - Execution limit is 10 seconds per cycle.

2. ENTRY POINT:
   Every script must export default an async function run:
   export default async function run({ market, positions, account, indicators, trade, log, params }) { ... }

3. CONTEXT API:
   - market.getPrice(pair: string): Promise<number>
   - market.getCandles(pair: string, timeframe: string, limit: number): Promise<Array<{ open, high, low, close, volume, time }>>
     Supported timeframes: '1m', '5m', '15m', '30m', '1h', '4h', '1d'.
   - positions.get(pair: string): Promise<{ id, accountId, pair, side: 'long'|'short', size, entryPrice, markPrice, leverage, unrealizedPnl, marginCurrency } | null>
   - positions.list(): Promise<Array<position>>
   - account.getBalance(): Promise<{ freeMargin: number, totalEquity: number, currency: string }>
   - indicators:
     - indicators.rsi(prices, period = 14) -> (number | null)[]
     - indicators.ema(prices, period) -> (number | null)[]
     - indicators.sma(prices, period) -> (number | null)[]
     - indicators.macd(prices, fast = 12, slow = 26, signal = 9) -> { macd, signal, histogram }
     - indicators.bollingerBands(prices, period = 20, stdDev = 2) -> { upper, middle, lower }
     - indicators.atr(candles, period = 14) -> (number | null)[]
     - indicators.supertrend(candles, period = 10, multiplier = 3) -> { trend: ('up'|'down')[], supertrend: (number | null)[] }
     - indicators.stochastic(candles, kPeriod = 14, dPeriod = 3, smooth = 3) -> { k, d }
     - indicators.vwap(candles) -> (number | null)[]
   - trade.buy({
       pair: string,
       orderType?: 'market' | 'limit',
       limitPrice?: number | string,
       sizingMode?: 'pct_basis' | 'exact_qty' | 'exact_quote',
       percentBp?: number, // e.g. 1000 = 10%
       size?: number | string,
       leverage?: number | string,
       marginCurrency?: 'INR' | 'USDT',
       stopLossPrice?: number | string,
       takeProfitPrice?: number | string,
       trailingStopLoss?: boolean,
       trailingDistanceBp?: number,
       trailingStepBp?: number,
     }): Promise<TradeResult>
   - trade.sell(options): Promise<TradeResult>
   - trade.close(pair: string): Promise<CloseResult>
   - trade.closeAll(): Promise<CloseResult[]>
   - log(message: string, data?: unknown): void
   - params: Record<string, unknown> (injected strategy configuration JSON)

4. ORDER SIZING & SAFETY CONVENTIONS:
   - Sizing in basis points: percentBp = percentage * 100 (e.g., 5% = 500, 10% = 1000, 15% = 1500).
   - Pair format: 'B-BTC_USDT', 'B-ETH_USDT', 'B-SOL_USDT'.
   - Idempotency: Always inspect existing position with \`await positions.get(pair)\` before opening a new position to prevent opening duplicate orders on repeated scheduled execution cycles.
   - Always validate candle history length before calculating technical indicators.
   - Return clean, production-ready JavaScript code.`;

export function AlgoRules() {
  const [copied, setCopied] = useState(false);

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(ALGO_AI_SYSTEM_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="landing landing-dark" style={{ minHeight: '100vh', background: '#0a0a0c', color: '#f4f4f5' }}>
      <MarketingHeader />

      <main style={{ maxWidth: 1040, margin: '0 auto', padding: '48px 20px 80px' }}>
        {/* Header Breadcrumb & Tag */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Link to="/app/algo" style={{ color: '#60a5fa', textDecoration: 'none', fontSize: 13, fontWeight: 500 }}>
            Algo Studio
          </Link>
          <span style={{ color: '#52525b', fontSize: 13 }}>/</span>
          <span style={{ color: '#a1a1aa', fontSize: 13 }}>Scripting Specification & AI Rules</span>
        </div>

        {/* Hero Section */}
        <div style={{ marginBottom: 40 }}>
          <h1 style={{ fontSize: 32, fontWeight: 800, color: '#ffffff', letterSpacing: '-0.02em', margin: '0 0 12px' }}>
            Aza WealthKare Algorithmic Scripting Rules for AI Models
          </h1>
          <p style={{ fontSize: 16, color: '#a1a1aa', lineHeight: 1.6, margin: 0, maxWidth: 840 }}>
            Use this specification to generate syntactically correct, production-ready trading strategies using
            Claude, ChatGPT, or DeepSeek that run directly inside Aza WealthKare with zero manual refactoring.
          </p>
        </div>

        {/* Action Bar */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            alignItems: 'center',
            background: '#121216',
            border: '1px solid #27272a',
            borderRadius: 10,
            padding: '16px 20px',
            marginBottom: 36,
          }}
        >
          <button
            type="button"
            onClick={handleCopyPrompt}
            style={{
              background: copied ? '#059669' : '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: 6,
              padding: '10px 20px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              transition: 'background 0.2s',
            }}
          >
            {copied ? 'Copied to Clipboard' : 'Copy AI System Prompt'}
          </button>

          <a
            href="/aza-wealthkare-algo-rules.md"
            download="aza-wealthkare-algo-rules.md"
            style={{
              background: '#1f1f23',
              color: '#f4f4f5',
              border: '1px solid #3f3f46',
              borderRadius: 6,
              padding: '10px 16px',
              fontSize: 13,
              fontWeight: 500,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            Download Markdown (.md)
          </a>

          <a
            href="https://chatgpt.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              background: '#1f1f23',
              color: '#d4d4d8',
              border: '1px solid #3f3f46',
              borderRadius: 6,
              padding: '10px 16px',
              fontSize: 13,
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            Open ChatGPT
          </a>

          <a
            href="https://claude.ai"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              background: '#1f1f23',
              color: '#d4d4d8',
              border: '1px solid #3f3f46',
              borderRadius: 6,
              padding: '10px 16px',
              fontSize: 13,
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            Open Claude
          </a>

          <Link
            to="/app/algo"
            style={{
              marginLeft: 'auto',
              color: '#60a5fa',
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Open Strategy Editor &rarr;
          </Link>
        </div>

        {/* Step-by-Step AI Instructions Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20, marginBottom: 40 }}>
          <div style={{ background: '#121216', border: '1px solid #27272a', borderRadius: 8, padding: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', marginBottom: 6 }}>
              Option A: ChatGPT / Claude Chat
            </div>
            <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 700, color: '#ffffff' }}>Direct Prompting</h3>
            <p style={{ fontSize: 13, color: '#a1a1aa', lineHeight: 1.5, margin: 0 }}>
              1. Click <strong>Copy AI System Prompt</strong> above.<br />
              2. Paste it at the start of your ChatGPT or Claude conversation.<br />
              3. Specify your strategy logic (e.g. &quot;Write a 15m Supertrend breakout strategy for BTC with 5x leverage&quot;).
            </p>
          </div>

          <div style={{ background: '#121216', border: '1px solid #27272a', borderRadius: 8, padding: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#10b981', textTransform: 'uppercase', marginBottom: 6 }}>
              Option B: Claude Projects / Custom GPT
            </div>
            <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 700, color: '#ffffff' }}>Permanent Knowledge Base</h3>
            <p style={{ fontSize: 13, color: '#a1a1aa', lineHeight: 1.5, margin: 0 }}>
              1. Download <code>aza-wealthkare-algo-rules.md</code>.<br />
              2. Upload it to your Claude Project knowledge files or Custom GPT instructions.<br />
              3. All subsequent strategy requests will automatically conform to Aza WealthKare runtime rules.
            </p>
          </div>

          <div style={{ background: '#121216', border: '1px solid #27272a', borderRadius: 8, padding: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', marginBottom: 6 }}>
              Option C: Web Browsing AI
            </div>
            <h3 style={{ margin: '0 0 10px', fontSize: 16, fontWeight: 700, color: '#ffffff' }}>URL Citation</h3>
            <p style={{ fontSize: 13, color: '#a1a1aa', lineHeight: 1.5, margin: 0 }}>
              Provide the live link <code>https://your-domain.com/aza-wealthkare-algo-rules.md</code> directly to browsing-enabled models.
              The AI model will fetch and parse the latest runtime constraints automatically.
            </p>
          </div>
        </div>

        {/* Copyable System Prompt Block */}
        <section style={{ marginBottom: 48 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#ffffff', margin: 0 }}>
              System Prompt for AI Models
            </h2>
            <button
              type="button"
              onClick={handleCopyPrompt}
              style={{
                background: 'transparent',
                border: '1px solid #3f3f46',
                color: copied ? '#10b981' : '#a1a1aa',
                borderRadius: 4,
                padding: '6px 12px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre
            style={{
              background: '#09090b',
              border: '1px solid #27272a',
              borderRadius: 8,
              padding: 20,
              fontSize: 12.5,
              color: '#d4d4d8',
              lineHeight: 1.6,
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              margin: 0,
            }}
          >
            {ALGO_AI_SYSTEM_PROMPT}
          </pre>
        </section>

        {/* Runtime Constraints Table */}
        <section style={{ marginBottom: 48 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#ffffff', margin: '0 0 16px' }}>
            Platform Runtime Rules
          </h2>
          <div style={{ border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#18181b', borderBottom: '1px solid #27272a', textAlign: 'left' }}>
                  <th style={{ padding: '12px 16px', color: '#a1a1aa', fontWeight: 600 }}>Constraint</th>
                  <th style={{ padding: '12px 16px', color: '#a1a1aa', fontWeight: 600 }}>Aza WealthKare Requirement</th>
                  <th style={{ padding: '12px 16px', color: '#a1a1aa', fontWeight: 600 }}>Reason</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid #1f1f23' }}>
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: '#e4e4e7' }}>Module Imports</td>
                  <td style={{ padding: '12px 16px', color: '#ef4444' }}>No \`require()\` or \`import ... from 'pkg'\`</td>
                  <td style={{ padding: '12px 16px', color: '#a1a1aa' }}>Execution runs inside a sandboxed VM with isolated memory.</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #1f1f23' }}>
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: '#e4e4e7' }}>Entry Function</td>
                  <td style={{ padding: '12px 16px', color: '#10b981' }}>\`export default async function run(context)\`</td>
                  <td style={{ padding: '12px 16px', color: '#a1a1aa' }}>Runner invokes \`run(context)\` on each scheduled cycle.</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #1f1f23' }}>
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: '#e4e4e7' }}>Position Sizing</td>
                  <td style={{ padding: '12px 16px', color: '#f59e0b' }}>\`percentBp\` (Basis Points: 100 bp = 1%)</td>
                  <td style={{ padding: '12px 16px', color: '#a1a1aa' }}>Prevents floating point precision errors during multi-account order allocations.</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #1f1f23' }}>
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: '#e4e4e7' }}>Idempotency</td>
                  <td style={{ padding: '12px 16px', color: '#60a5fa' }}>Check \`await positions.get(pair)\`</td>
                  <td style={{ padding: '12px 16px', color: '#a1a1aa' }}>Prevents creating duplicate positions on every scheduled cycle.</td>
                </tr>
                <tr>
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: '#e4e4e7' }}>Execution Timeout</td>
                  <td style={{ padding: '12px 16px', color: '#a1a1aa' }}>Maximum 10 seconds</td>
                  <td style={{ padding: '12px 16px', color: '#a1a1aa' }}>Guarantees scheduler responsiveness across all tenant strategies.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Working Example */}
        <section style={{ marginBottom: 48 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#ffffff', margin: '0 0 16px' }}>
            Reference Strategy Implementation
          </h2>
          <div style={{ background: '#09090b', border: '1px solid #27272a', borderRadius: 8, padding: 20 }}>
            <pre style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: '#e4e4e7', overflowX: 'auto' }}>
{`/**
 * Supertrend Trend Following Strategy
 */
export default async function run({ market, positions, indicators, trade, log, params }) {
  const pair = params.pair || "B-BTC_USDT";
  const timeframe = params.timeframe || "15m";
  const period = Number(params.stPeriod) || 10;
  const multiplier = Number(params.stMultiplier) || 3;

  const candles = await market.getCandles(pair, timeframe, 80);
  if (!candles || candles.length < period + 5) {
    log("Loading Supertrend history...");
    return;
  }

  const st = indicators.supertrend(candles, period, multiplier);
  const len = candles.length;
  const currentTrend = st.trend[len - 1];
  const prevTrend = st.trend[len - 2];
  const stLevel = st.supertrend[len - 1];
  const currentPrice = candles[len - 1].close;

  log("Price: " + currentPrice + " | Trend: " + currentTrend + " | ST Level: " + stLevel?.toFixed(2));

  const currentPos = await positions.get(pair);

  if (prevTrend === "down" && currentTrend === "up") {
    log("Supertrend flipped to BULLISH! Opening long position...");
    if (currentPos && currentPos.side === "short") {
      await trade.close(pair);
    }
    await trade.buy({
      pair,
      orderType: "market",
      sizingMode: "pct_basis",
      percentBp: (Number(params.sizePct) || 10) * 100, // 10% in basis points
      leverage: Number(params.leverage) || 5,
      marginCurrency: params.marginCurrency || "USDT",
      stopLossPrice: stLevel?.toFixed(2),
    });
  } else if (prevTrend === "up" && currentTrend === "down") {
    log("Supertrend flipped to BEARISH!");
    if (currentPos && currentPos.side === "long") {
      log("Closing long position on trend reversal...");
      await trade.close(pair);
    }
  }
}`}
            </pre>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
