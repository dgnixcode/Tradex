import { useEffect, useState, useMemo } from 'react';
import type { AssetOption } from '../api.ts';

const STORAGE_KEY = 'tradex_watchlist_v1';
const DEFAULT_COINS = ['BTC', 'ETH', 'SOL', 'DASH', 'ZEC', 'DOGE', 'XRP', 'AVAX', 'BNB'];

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
    const assetNames = allAssets.length > 0
      ? allAssets.map((a) => a.asset)
      : Object.keys(MOCK_BASELINE_STATS);

    const available = assetNames.filter((a) => !watchlist.includes(a));
    if (!search.trim()) return available.slice(0, 8);
    const query = search.toUpperCase().trim();
    return available.filter((a) => a.includes(query)).slice(0, 10);
  }, [allAssets, watchlist, search]);

  return (
    <div
      className="watchlist-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        minHeight: 480,
        background: '#131722',
        borderRadius: 12,
        border: '1px solid var(--line, #232838)',
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
          borderBottom: '1px solid var(--line, #232838)',
          background: '#10141d',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>★</span>
          <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text, #f0f3f8)', letterSpacing: '0.02em' }}>
            Watchlist
          </span>
          <span
            style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 999,
              background: 'var(--surface-3, #222938)',
              color: 'var(--muted, #828e9e)',
            }}
          >
            {watchlist.length}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setShowAddMenu((v) => !v)}
          style={{
            background: showAddMenu ? 'var(--accent, #2962ff)' : 'var(--surface-3, #222938)',
            color: showAddMenu ? '#fff' : 'var(--text-dim, #c5cdd9)',
            border: 'none',
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
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line, #232838)' }}>
        <input
          type="text"
          placeholder="Filter or search coin…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: '#0b0e14',
            border: '1px solid var(--line, #232838)',
            borderRadius: 6,
            padding: '7px 10px',
            fontSize: 12.5,
            color: 'var(--text, #f0f3f8)',
            outline: 'none',
          }}
        />
      </div>

      {/* ── Add Suggestions Dropdown ── */}
      {showAddMenu && (
        <div
          style={{
            padding: '10px 12px',
            background: '#0e121a',
            borderBottom: '1px solid var(--line, #232838)',
            maxHeight: 180,
            overflowY: 'auto',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted, #828e9e)', marginBottom: 6 }}>
            QUICK ADD TO WATCHLIST:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {suggestions.map((coin) => (
              <button
                key={coin}
                type="button"
                onClick={() => addCoin(coin)}
                style={{
                  background: '#1a202c',
                  color: 'var(--text-dim, #c5cdd9)',
                  border: '1px solid var(--line, #232838)',
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
          const stat = MOCK_BASELINE_STATS[coin] ?? { price: '—', change: 0 };
          const isPos = stat.change >= 0;

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
                borderLeft: isSelected ? '3px solid var(--accent, #2962ff)' : '3px solid transparent',
                background: isSelected ? 'rgba(41, 98, 255, 0.12)' : 'transparent',
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
                    {stat.price !== '—' ? `$${stat.price}` : '—'}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: isPos ? '#0ecb81' : '#f6465d',
                    }}
                  >
                    {isPos ? `+${stat.change.toFixed(2)}%` : `${stat.change.toFixed(2)}%`}
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
              background: 'var(--accent, #2962ff)',
              color: '#fff',
              border: 'none',
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
