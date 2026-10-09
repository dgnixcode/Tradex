// Technical indicators for algorithmic trading strategies.
// Pure mathematical functions operating on price series or OHLCV candlestick arrays.

export interface CandleData {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly time: number;
}

/**
 * Simple Moving Average (SMA).
 */
export function sma(values: readonly number[], period: number): (number | null)[] {
  if (period <= 0 || values.length === 0) return values.map(() => null);
  const result: (number | null)[] = [];
  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) {
      sum -= values[i - period]!;
    }
    if (i >= period - 1) {
      result.push(sum / period);
    } else {
      result.push(null);
    }
  }

  return result;
}

/**
 * Exponential Moving Average (EMA).
 */
export function ema(values: readonly number[], period: number): (number | null)[] {
  if (period <= 0 || values.length === 0) return values.map(() => null);
  const result: (number | null)[] = [];
  const multiplier = 2 / (period + 1);

  let initialSmaSum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      initialSmaSum += values[i]!;
      result.push(null);
    } else if (i === period - 1) {
      initialSmaSum += values[i]!;
      const currentEma = initialSmaSum / period;
      result.push(currentEma);
    } else {
      const prevEma = result[i - 1]!;
      const currentEma = (values[i]! - prevEma) * multiplier + prevEma;
      result.push(currentEma);
    }
  }

  return result;
}

/**
 * Relative Strength Index (RSI) using Wilder's Smoothing.
 */
export function rsi(values: readonly number[], period = 14): (number | null)[] {
  if (period <= 0 || values.length <= period) return values.map(() => null);
  const result: (number | null)[] = [];

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      result.push(null);
      continue;
    }

    const change = values[i]! - values[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (i < period) {
      avgGain += gain;
      avgLoss += loss;
      result.push(null);
    } else if (i === period) {
      avgGain = (avgGain + gain) / period;
      avgLoss = (avgLoss + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    }
  }

  return result;
}

/**
 * Moving Average Convergence Divergence (MACD).
 */
export function macd(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
} {
  const fastEma = ema(values, fastPeriod);
  const slowEma = ema(values, slowPeriod);

  const macdLine: (number | null)[] = [];
  const validMacdValues: number[] = [];

  for (let i = 0; i < values.length; i++) {
    if (fastEma[i] !== null && slowEma[i] !== null) {
      const diff = fastEma[i]! - slowEma[i]!;
      macdLine.push(diff);
      validMacdValues.push(diff);
    } else {
      macdLine.push(null);
    }
  }

  const signalLineValid = ema(validMacdValues, signalPeriod);
  const signalLine: (number | null)[] = [];
  const histogram: (number | null)[] = [];

  let signalIdx = 0;
  for (let i = 0; i < values.length; i++) {
    if (macdLine[i] === null) {
      signalLine.push(null);
      histogram.push(null);
    } else {
      const sig = signalLineValid[signalIdx] ?? null;
      signalLine.push(sig);
      if (sig !== null) {
        histogram.push(macdLine[i]! - sig);
      } else {
        histogram.push(null);
      }
      signalIdx++;
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * Bollinger Bands.
 */
export function bollingerBands(
  values: readonly number[],
  period = 20,
  stdDevMultiplier = 2,
): {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
} {
  const middle = sma(values, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];

  for (let i = 0; i < values.length; i++) {
    const mid = middle[i];
    if (mid === null || mid === undefined || i < period - 1) {
      upper.push(null);
      lower.push(null);
      continue;
    }

    let varianceSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = values[j]! - mid;
      varianceSum += diff * diff;
    }
    const stdDev = Math.sqrt(varianceSum / period);
    upper.push(mid + stdDevMultiplier * stdDev);
    lower.push(mid - stdDevMultiplier * stdDev);
  }

  return { upper, middle, lower };
}

/**
 * Average True Range (ATR).
 */
export function atr(
  candles: readonly { high: number; low: number; close: number }[],
  period = 14,
): (number | null)[] {
  if (candles.length === 0 || period <= 0) return candles.map(() => null);
  const trueRanges: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const current = candles[i]!;
    if (i === 0) {
      trueRanges.push(current.high - current.low);
    } else {
      const prevClose = candles[i - 1]!.close;
      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - prevClose),
        Math.abs(current.low - prevClose),
      );
      trueRanges.push(tr);
    }
  }

  const result: (number | null)[] = [];
  let atrValue = 0;

  for (let i = 0; i < trueRanges.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += trueRanges[j]!;
      }
      atrValue = sum / period;
      result.push(atrValue);
    } else {
      atrValue = (atrValue * (period - 1) + trueRanges[i]!) / period;
      result.push(atrValue);
    }
  }

  return result;
}

/**
 * Supertrend indicator.
 */
export function supertrend(
  candles: readonly { high: number; low: number; close: number }[],
  period = 10,
  multiplier = 3,
): {
  trend: ('up' | 'down')[];
  supertrend: (number | null)[];
} {
  const atrValues = atr(candles, period);
  const supertrendArr: (number | null)[] = [];
  const trendArr: ('up' | 'down')[] = [];

  let prevUpperBand = 0;
  let prevLowerBand = 0;
  let prevSupertrend = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const currAtr = atrValues[i];

    if (currAtr === null || currAtr === undefined) {
      supertrendArr.push(null);
      trendArr.push('up');
      continue;
    }

    const hl2 = (c.high + c.low) / 2;
    const basicUpperBand = hl2 + multiplier * currAtr;
    const basicLowerBand = hl2 - multiplier * currAtr;

    const prevClose = i > 0 ? candles[i - 1]!.close : c.close;

    const finalUpperBand =
      basicUpperBand < prevUpperBand || prevClose > prevUpperBand
        ? basicUpperBand
        : prevUpperBand;

    const finalLowerBand =
      basicLowerBand > prevLowerBand || prevClose < prevLowerBand
        ? basicLowerBand
        : prevLowerBand;

    let currentTrend: 'up' | 'down';

    if (prevSupertrend === prevUpperBand) {
      currentTrend = c.close > finalUpperBand ? 'up' : 'down';
    } else {
      currentTrend = c.close < finalLowerBand ? 'down' : 'up';
    }

    const currentSupertrend = currentTrend === 'up' ? finalLowerBand : finalUpperBand;

    prevUpperBand = finalUpperBand;
    prevLowerBand = finalLowerBand;
    prevSupertrend = currentSupertrend;

    supertrendArr.push(currentSupertrend);
    trendArr.push(currentTrend);
  }

  return { trend: trendArr, supertrend: supertrendArr };
}

/**
 * Stochastic Oscillator (%K and %D).
 */
export function stochastic(
  candles: readonly { high: number; low: number; close: number }[],
  period = 14,
  kSmooth = 3,
  dSmooth = 3,
): {
  k: (number | null)[];
  d: (number | null)[];
} {
  const rawK: (number | null)[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      rawK.push(null);
      continue;
    }

    let highestHigh = -Infinity;
    let lowestLow = Infinity;

    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j]!.high > highestHigh) highestHigh = candles[j]!.high;
      if (candles[j]!.low < lowestLow) lowestLow = candles[j]!.low;
    }

    const range = highestHigh - lowestLow;
    if (range === 0) {
      rawK.push(50);
    } else {
      rawK.push(((candles[i]!.close - lowestLow) / range) * 100);
    }
  }

  const validK: number[] = [];
  for (const v of rawK) {
    if (v !== null) validK.push(v);
  }

  const smoothedKValid = sma(validK, kSmooth);
  const kArr: (number | null)[] = [];
  let sIdx = 0;

  for (let i = 0; i < candles.length; i++) {
    if (rawK[i] === null) {
      kArr.push(null);
    } else {
      kArr.push(smoothedKValid[sIdx] ?? null);
      sIdx++;
    }
  }

  const validSmoothK: number[] = [];
  for (const v of kArr) {
    if (v !== null) validSmoothK.push(v);
  }

  const dValid = sma(validSmoothK, dSmooth);
  const dArr: (number | null)[] = [];
  let dIdx = 0;

  for (let i = 0; i < candles.length; i++) {
    if (kArr[i] === null) {
      dArr.push(null);
    } else {
      dArr.push(dValid[dIdx] ?? null);
      dIdx++;
    }
  }

  return { k: kArr, d: dArr };
}
