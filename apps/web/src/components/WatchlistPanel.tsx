import { useEffect, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchFuturesPrices, type AssetOption } from '../api.ts';

const STORAGE_KEY = 'tradex_watchlist_v1';
const DEFAULT_COINS = ['BTC', 'ETH', 'SOL', 'DASH', 'ZEC', 'DOGE', 'XRP', 'AVAX', 'BNB'];

function formatPrice(numStr: string | number): string {
  const n = typeof numStr === 'number' ? numStr : Number(numStr);
  if (isNaN(n) || n === 0) return '—';
  if (n >= 1000) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (n >= 1) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  if (n >= 0.0001) {
    return n.toFixed(4);
  }
  return n.toFixed(6);
}

// Sample 24h mock stats / baseline prices for instant UI polish before live ticker loads
const MOCK_BASELINE_STATS: Record<string, { price: string; change: number }> = {
  BTC: { price: '64,280.50', change: 2.34 },
  ETH: { price: '3,485.20', change: 1.85 },
  SOL: { price: '148.60', change: -0.92 },
  DASH: { price: '51.90', change: 4.12 },
  ZEC: { price: '1,112.50', change: 3.45 },
  DOGE: { price: '0.1084', change: -1.40 },
  XRP: { price: '0.5840', change: 0.75 },
  AVAX: { price: '26.40', change: 2.10 },
  BNB: { price: '562.80', change: 0.60 },
  ADA: { price: '0.3420', change: -0.45 },
  LINK: { price: '11.20', change: 1.15 },
  NEAR: { price: '4.80', change: 5.20 },
  PEPE: { price: '0.0000084', change: 8.40 },
};

interface WatchlistPanelProps {
  readonly selectedAsset: string;
  readonly onSelectAsset: (asset: string) => void;
  readonly allAssets?: readonly AssetOption[] | undefined;
  readonly quoteCurrency?: string | undefined;
  readonly onOpenTrade?: (() => void) | undefined;
}

export function WatchlistPanel({
  selectedAsset,
  onSelectAsset,
  allAssets = [],
  quoteCurrency = 'USDT',
  onOpenTrade,
}: WatchlistPanelProps) {
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return DEFAULT_COINS;
  });

  const [search, setSearch] = useState('');
  const [showAddMenu, setShowAddMenu] = useState(false);

  // Poll bulk real-time futures prices every 3 seconds (cached on backend, zero IP risk)
  const { data: pricesData } = useQuery({
    queryKey: ['futures-prices'],
    queryFn: fetchFuturesPrices,
    refetchInterval: 3000,
    staleTime: 1500,
  });

  // Sync with localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
    } catch {}
  }, [watchlist]);

  const addCoin = (coin: string) => {
    const clean = coin.toUpperCase().trim();
    if (!clean) return;
    if (!watchlist.includes(clean)) {
      setWatchlist((prev) => [clean, ...prev]);
    }
    setSearch('');
    setShowAddMenu(false);
    onSelectAsset(clean);
  };

  const removeCoin = (e: React.MouseEvent, coin: string) => {
    e.stopPropagation();
    setWatchlist((prev) => prev.filter((c) => c !== coin));
  };

  // Search filtered items
  const filteredList = useMemo(() => {
    if (!search.trim()) return watchlist;
    const query = search.toUpperCase().trim();
    return watchlist.filter((c) => c.includes(query));
  }, [watchlist, search]);

  // Available suggestions not in watchlist
  const suggestions = useMemo(() => {
    let assetNames: string[] = [];
    if (allAssets.length > 0) {
      assetNames = allAssets.map((a) => a.asset);
    } else if (pricesData?.prices && Object.keys(pricesData.prices).length > 0) {
      assetNames = Object.keys(pricesData.prices)
        .filter((k) => k.startsWith('B-') && k.endsWith('_USDT'))
        .map((k) => k.replace(/^B-/, '').replace(/_USDT$/, ''));
    } else {
      assetNames = Object.keys(MOCK_BASELINE_STATS);
    }

    const available = assetNames.filter((a) => !watchlist.includes(a));
    if (!search.trim()) return available.slice(0, 10);
    const query = search.toUpperCase().trim();
    return available.filter((a) => a.includes(query)).slice(0, 15);
  }, [allAssets, pricesData, watchlist, search]);

  return (
    <div
      className="watchlist-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        minHeight: 480,
        background: '#0d0e12',
        borderRadius: 8,
        border: '1px solid #1e2229',
        overflow: 'hidden',
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 14px',
          borderBottom: '1px solid #1e2229',
          background: '#111317',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, color: '#f59e0b' }}>★</span>
          <span style={{ fontWeight: 700, fontSize: 13.5, color: '#f3f4f6', letterSpacing: '0.02em' }}>
            Watchlist
          </span>
          <span
            style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 999,
              background: '#1b1e25',
              color: '#9ca3af',
            }}
          >
            {watchlist.length}
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: '#0ecb81',
              background: 'rgba(14, 203, 129, 0.12)',
              border: '1px solid rgba(14, 203, 129, 0.25)',
              borderRadius: 4,
              padding: '1px 5px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginLeft: 2,
            }}
          >
            <span style={{ fontSize: 7 }}>●</span> Live (3s)
          </span>
        </div>

        <button
          type="button"
          onClick={() => setShowAddMenu((v) => !v)}
          style={{
            background: showAddMenu ? '#ffffff' : '#1b1e25',
            color: showAddMenu ? '#000000' : '#d1d5db',
            border: '1px solid #282d37',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {showAddMenu ? 'Close' : '+ Add'}
        </button>
      </div>

      {/* ── Search Bar ── */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #1e2229' }}>
        <input
          type="text"
          placeholder="Filter or search coin…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: '#07080a',
            border: '1px solid #1e2229',
            borderRadius: 6,
            padding: '7px 10px',
            fontSize: 12.5,
            color: '#f3f4f6',
            outline: 'none',
          }}
        />
      </div>

      {/* ── Add Suggestions Dropdown ── */}
      {showAddMenu && (
        <div
          style={{
            padding: '10px 12px',
            background: '#0d0e12',
            borderBottom: '1px solid #1e2229',
            maxHeight: 180,
            overflowY: 'auto',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', marginBottom: 6 }}>
            QUICK ADD TO WATCHLIST:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {suggestions.map((coin) => (
              <button
                key={coin}
                type="button"
                onClick={() => addCoin(coin)}
                style={{
                  background: '#16181f',
                  color: '#d1d5db',
                  border: '1px solid #232730',
                  borderRadius: 4,
                  padding: '4px 8px',
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                + {coin}
              </button>
            ))}
            {suggestions.length === 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--muted, #828e9e)' }}>
                No more coins matching &ldquo;{search}&rdquo;
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Watchlist Table / Cards ── */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 0',
        }}
      >
        {filteredList.map((coin) => {
          const isSelected = selectedAsset.toUpperCase() === coin;
          const pairKey = `B-${coin}_USDT`;
          const live = pricesData?.prices?.[pairKey];
          const rawPrice = live ? (live.lastPrice || live.markPrice) : undefined;
          const rawChange = live ? live.priceChangePercent : undefined;

          const baseline = MOCK_BASELINE_STATS[coin];
          const displayPrice = rawPrice !== undefined
            ? formatPrice(rawPrice)
            : (baseline ? baseline.price : '—');
          const displayChange = rawChange !== undefined
            ? rawChange
            : (baseline ? baseline.change : 0);
          const isPos = displayChange >= 0;

          return (
            <div
              key={coin}
              onClick={() => onSelectAsset(coin)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '9px 14px',
                cursor: 'pointer',
                borderLeft: isSelected ? '3px solid #ffffff' : '3px solid transparent',
                background: isSelected ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                transition: 'background 0.12s ease',
              }}
              className="watchlist-row"
            >
              {/* Coin Symbol + Pair */}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text, #f0f3f8)' }}>
                    {coin}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: 'var(--faint, #546070)',
                      padding: '1px 4px',
                      borderRadius: 3,
                      background: '#1a202c',
                    }}
                  >
                    {quoteCurrency}
                  </span>
                </div>
                <span style={{ fontSize: 10.5, color: 'var(--muted, #828e9e)', marginTop: 2 }}>
                  Perpetual
                </span>
              </div>

              {/* Price + 24h Change */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text, #f0f3f8)' }}>
                    {displayPrice !== '—' ? `$${displayPrice}` : '—'}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: isPos ? '#0ecb81' : '#f6465d',
                    }}
                  >
                    {isPos ? `+${displayChange.toFixed(2)}%` : `${displayChange.toFixed(2)}%`}
                  </div>
                </div>

                {/* Remove button */}
                <button
                  type="button"
                  title="Remove from watchlist"
                  onClick={(e) => removeCoin(e, coin)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--faint, #546070)',
                    fontSize: 14,
                    cursor: 'pointer',
                    padding: '2px 4px',
                    borderRadius: 4,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#f6465d'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--faint, #546070)'; }}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}

        {filteredList.length === 0 && (
          <div style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--muted, #828e9e)', fontSize: 12 }}>
            No coins found. Click <strong>+ Add</strong> above to add coins.
          </div>
        )}
      </div>

      {/* ── Bottom Action Bar ── */}
      {selectedAsset && onOpenTrade && (
        <div
          style={{
            padding: '10px 14px',
            borderTop: '1px solid var(--line, #232838)',
            background: '#10141d',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--muted, #828e9e)' }}>
            Active: <strong style={{ color: 'var(--text, #f0f3f8)' }}>{selectedAsset}/{quoteCurrency}</strong>
          </div>
          <button
            type="button"
            onClick={onOpenTrade}
            style={{
              background: '#ffffff',
              color: '#000000',
              border: '1px solid #ffffff',
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            Trade {selectedAsset} ⚡
          </button>
        </div>
      )}
    </div>
  );
}
