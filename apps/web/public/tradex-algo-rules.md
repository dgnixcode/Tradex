# Aza WealthKare Algorithmic Trading Script Specification

This document defines the runtime environment, API contracts, indicators, and safety rules for algorithmic trading strategies running on the Aza WealthKare platform.

AI models (such as Claude, ChatGPT, and DeepSeek) must strictly adhere to these rules when generating strategy scripts.

---

## 1. Runtime Environment & Isolation

- **Engine**: Sandboxed Node.js VM.
- **Language**: Pure ES2022 JavaScript / async function.
- **Forbidden**:
  - No `require(...)` statements.
  - No external `import` statements (e.g., `import ccxt`, `import axios`).
  - No arbitrary HTTP requests or `fetch()`.
  - No filesystem, network socket, or process access.
- **Allowed Built-ins**: Standard JavaScript globals: `Math`, `Date`, `JSON`, `Array`, `Object`, `String`, `Number`, `Boolean`, `Map`, `Set`, `Promise`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`.
- **Execution Limit**: 10 seconds per execution cycle.

---

## 2. Strategy Entrypoint

Every script must either export default an async function `run` or declare `async function run`:

```javascript
export default async function run({ market, positions, account, indicators, trade, log, params }) {
  // Strategy execution logic here
}
```

The Aza WealthKare algorithmic engine executes this function periodically according to the strategy schedule interval (e.g., every 1m, 5m, 15m, 1h).

---

## 3. Context API Reference

### 3.1 `market`
- `market.getPrice(pair: string): Promise<number>`
  Returns the current mark price of the futures contract as a number.
  Example: `const price = await market.getPrice('B-BTC_USDT');`

- `market.getCandles(pair: string, timeframe: string = '5m', limit: number = 100): Promise<Candle[]>`
  Returns an array of historical OHLCV candlestick objects sorted from oldest to newest.
  Supported timeframes: `'1m'`, `'5m'`, `'15m'`, `'30m'`, `'1h'`, `'4h'`, `'1d'`.
  Candle structure:
  ```typescript
  interface Candle {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    time: number; // Unix timestamp in seconds
  }
  ```

---

### 3.2 `positions`
- `positions.get(pair: string): Promise<Position | null>`
  Returns the active futures position for the specified pair, or `null` if no active position exists.
  Position structure:
  ```typescript
  interface Position {
    id: string;
    accountId: string;
    pair: string;
    side: 'long' | 'short';
    size: number;
    entryPrice: number;
    markPrice: number;
    leverage: number;
    unrealizedPnl: number;
    marginCurrency: 'INR' | 'USDT';
  }
  ```

- `positions.list(): Promise<Position[]>`
  Returns an array of all active positions held by the target account or group.

---

### 3.3 `account`
- `account.getBalance(): Promise<{ freeMargin: number; totalEquity: number; currency: string }>`
  Returns the current free margin, total equity, and base currency.

---

### 3.4 `indicators`
Built-in technical indicators operating on numeric price arrays (e.g. `candles.map(c => c.close)`) or candlestick arrays:

| Function | Parameters | Return Type | Description |
| :--- | :--- | :--- | :--- |
| `indicators.rsi(prices, period = 14)` | `(number[], number)` | `(number \| null)[]` | Relative Strength Index (Wilder's) |
| `indicators.ema(prices, period)` | `(number[], number)` | `(number \| null)[]` | Exponential Moving Average |
| `indicators.sma(prices, period)` | `(number[], number)` | `(number \| null)[]` | Simple Moving Average |
| `indicators.macd(prices, fast = 12, slow = 26, signal = 9)` | `(number[], number, number, number)` | `{ macd: [], signal: [], histogram: [] }` | Moving Average Convergence Divergence |
| `indicators.bollingerBands(prices, period = 20, stdDev = 2)` | `(number[], number, number)` | `{ upper: [], middle: [], lower: [] }` | Bollinger Bands |
| `indicators.atr(candles, period = 14)` | `(Candle[], number)` | `(number \| null)[]` | Average True Range |
| `indicators.supertrend(candles, period = 10, mult = 3)` | `(Candle[], number, number)` | `{ trend: ('up' \| 'down')[], supertrend: [] }` | Supertrend indicator |
| `indicators.stochastic(candles, kPeriod = 14, dPeriod = 3, smooth = 3)` | `(Candle[], number, number, number)` | `{ k: [], d: [] }` | Stochastic Oscillator |
| `indicators.vwap(candles)` | `(Candle[])` | `(number \| null)[]` | Volume Weighted Average Price |

---

### 3.5 `trade`
- `trade.buy(options): Promise<TradeResult>`
  Opens a new long position, or increases an existing long position.
- `trade.sell(options): Promise<TradeResult>`
  Opens a new short position, or increases an existing short position.

**Options**:
```typescript
interface TradeOptions {
  pair: string;                       // e.g. 'B-BTC_USDT'
  orderType?: 'market' | 'limit';     // default: 'market'
  limitPrice?: number | string;       // required if orderType === 'limit'
  sizingMode?: 'pct_basis' | 'exact_qty' | 'exact_quote'; // default: 'pct_basis'
  percentBp?: number;                 // Sizing in basis points (100 bp = 1%, e.g. 1500 = 15%)
  size?: number | string;             // Exact quantity or quote amount if sizingMode is exact
  leverage?: number | string;         // e.g. 5, 10, 20
  marginCurrency?: 'INR' | 'USDT';    // default: 'USDT'
  stopLossPrice?: number | string;    // SL trigger price
  takeProfitPrice?: number | string;  // TP trigger price
  trailingStopLoss?: boolean;         // Enable dynamic trailing stop
  trailingDistanceBp?: number;        // Trailing distance in basis points (optional)
  trailingStepBp?: number;            // Trailing step in basis points (optional)
}
```

- `trade.close(pair: string): Promise<CloseResult>`
  Closes the active futures position for the specified pair at market price.
- `trade.closeAll(): Promise<CloseResult[]>`
  Closes all active futures positions across the target account or group.

---

### 3.6 `log` & `params`
- `log(message: string, data?: unknown): void`
  Records an execution log entry displayed in the Aza WealthKare strategy telemetry tab.
- `params: Record<string, unknown>`
  Runtime parameters defined in JSON in the strategy settings tab (e.g., `params.rsiPeriod`, `params.leverage`).

---

## 4. Critical Engineering Rules for AI Models

1. **Idempotency**:
   Strategy cycles trigger automatically on schedule. The script must check existing positions before placing orders:
   ```javascript
   const currentPos = await positions.get(pair);
   if (!currentPos) {
     // Enter new position
   }
   ```
2. **Basis Points Sizing**:
   Aza WealthKare calculates position percentage in **basis points**:
   - `5%` = `500`
   - `10%` = `1000`
   - `15%` = `1500`
   - Formula: `percentBp = percentage * 100`.
3. **Pair Naming Format**:
   Always format futures pairs using the exchange contract prefix:
   - `'B-BTC_USDT'`, `'B-ETH_USDT'`, `'B-SOL_USDT'`, `'B-DOGE_USDT'`, etc.
4. **Data Validation**:
   Always verify sufficient candle history is returned before accessing array indices:
   ```javascript
   const candles = await market.getCandles(pair, timeframe, 80);
   if (!candles || candles.length < 30) {
     log("Insufficient candle data");
     return;
   }
   ```
5. **No Outer Exports**:
   Do not declare named exports like `export const config = ...`. Only export default the `run` function.

---

## 5. Production Strategy Examples

### Example: RSI Momentum Reversion Strategy
```javascript
export default async function run({ market, positions, indicators, trade, log, params }) {
  const pair = params.pair || "B-BTC_USDT";
  const timeframe = params.timeframe || "15m";
  const rsiPeriod = Number(params.rsiPeriod) || 14;
  const oversold = Number(params.oversold) || 30;
  const overbought = Number(params.overbought) || 70;

  const candles = await market.getCandles(pair, timeframe, 100);
  if (!candles || candles.length < rsiPeriod + 10) {
    log("Insufficient candle data for RSI calculation");
    return;
  }

  const closes = candles.map(c => c.close);
  const rsiValues = indicators.rsi(closes, rsiPeriod);
  const currentRsi = rsiValues[rsiValues.length - 1];
  const currentPrice = closes[closes.length - 1];

  log(`Price: ${currentPrice} | RSI: ${currentRsi !== null ? currentRsi.toFixed(2) : 'N/A'}`);
  if (currentRsi === null) return;

  const currentPos = await positions.get(pair);

  if (currentRsi <= oversold && (!currentPos || currentPos.side !== "long")) {
    log(`RSI ${currentRsi.toFixed(1)} <= ${oversold}. Entering LONG...`);
    if (currentPos && currentPos.side === "short") {
      await trade.close(pair);
    }
    await trade.buy({
      pair,
      orderType: "market",
      sizingMode: "pct_basis",
      percentBp: (Number(params.sizePct) || 10) * 100,
      leverage: Number(params.leverage) || 5,
      marginCurrency: params.marginCurrency || "USDT",
      stopLossPrice: (currentPrice * 0.97).toFixed(2),
      takeProfitPrice: (currentPrice * 1.05).toFixed(2),
    });
  } else if (currentRsi >= overbought && currentPos && currentPos.side === "long") {
    log(`RSI ${currentRsi.toFixed(1)} >= ${overbought}. Exiting LONG to secure profit...`);
    await trade.close(pair);
  }
}
```
