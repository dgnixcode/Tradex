import { useState } from 'react';
import type { KillSwitchStatus } from '../api.ts';

export interface KillSwitchModalProps {
  readonly isOpen: boolean;
  readonly isHalted: boolean;
  readonly status?: KillSwitchStatus | undefined;
  readonly onClose: () => void;
  readonly onToggle: (active: boolean, reason?: string) => void;
  readonly isToggling: boolean;
}

export function KillSwitchModal({
  isOpen,
  isHalted,
  status,
  onClose,
  onToggle,
  isToggling,
}: KillSwitchModalProps) {
  const [confirmInput, setConfirmInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');

  if (!isOpen) return null;

  const canDisengage = confirmInput.trim().toUpperCase() === 'CONFIRM';

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        backdropFilter: 'blur(4px)',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--panel-bg, #1a1d24)',
          border: `1px solid ${isHalted ? 'var(--danger)' : 'var(--line)'}`,
          borderRadius: 8,
          maxWidth: 540,
          width: '100%',
          padding: 24,
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.3)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                backgroundColor: isHalted ? 'var(--danger)' : 'var(--ok)',
                display: 'inline-block',
                boxShadow: isHalted ? '0 0 10px var(--danger)' : 'none',
              }}
            />
            <h3 style={{ margin: 0, fontSize: 18 }}>
              {isHalted ? 'Emergency Kill Switch (ACTIVE)' : 'Emergency Kill Switch'}
            </h3>
          </div>
          <button
            type="button"
            className="btn btn-sm secondary"
            onClick={onClose}
            style={{ padding: '2px 8px', fontSize: 13 }}
          >
            ✕
          </button>
        </div>

        {isHalted ? (
          <div>
            <div
              style={{
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid var(--danger)',
                borderRadius: 6,
                padding: '12px 14px',
                marginBottom: 16,
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              <strong style={{ color: 'var(--danger)' }}>Platform is currently LOCKED in Read-Only Mode.</strong>
              <div style={{ color: 'var(--text-dim)', marginTop: 4 }}>
                All order placement, position exits, adjustments, and SL/TP updates are rejected at the API, background worker, and Signer levels.
              </div>
              {status?.reason && (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  <span className="muted">Reason: </span>
                  <code>{status.reason}</code>
                </div>
              )}
              {status?.changedAt && (
                <div style={{ marginTop: 2, fontSize: 12 }}>
                  <span className="muted">Locked at: </span>
                  <span>{new Date(status.changedAt).toLocaleString('en-IN')}</span>
                </div>
              )}
            </div>

            <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
              To disengage the Kill Switch and resume live trading and order execution, type <strong>CONFIRM</strong> below:
            </p>

            <input
              type="text"
              placeholder="Type CONFIRM to resume trading"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: 'var(--input-bg, #0e1117)',
                border: `1px solid ${canDisengage ? 'var(--ok)' : 'var(--line)'}`,
                borderRadius: 6,
                color: 'var(--text)',
                fontSize: 14,
                fontFamily: 'monospace',
                marginBottom: 16,
                boxSizing: 'border-box',
              }}
            />

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="btn secondary" onClick={onClose} disabled={isToggling}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!canDisengage || isToggling}
                onClick={() => onToggle(false, 'Trading resumed via UI')}
                style={{
                  backgroundColor: canDisengage ? 'var(--ok)' : undefined,
                  borderColor: canDisengage ? 'var(--ok)' : undefined,
                }}
              >
                {isToggling ? 'Resuming…' : 'Resume Live Trading'}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 14 }}>
              Engaging the Emergency Kill Switch immediately puts the entire platform into <strong>Read-Only Mode</strong>.
            </p>
            <ul style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.6, paddingLeft: 20, margin: '0 0 16px' }}>
              <li><strong>Signer Deadbolt:</strong> The cryptographic signer refuses to sign any order placement, cancel, or exit requests.</li>
              <li><strong>API Guard:</strong> All trade placement, exit, adjustment, and SL/TP endpoints return HTTP 403 Forbidden.</li>
              <li><strong>Background Workers:</strong> Trailing SL and automated execution loops are paused.</li>
              <li><strong>Safe Read-Only:</strong> Balances, live position tracking, mark prices, and order books remain fully readable.</li>
            </ul>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              Lock Reason (Optional)
            </label>
            <input
              type="text"
              placeholder="e.g. Code update in progress / Maintenance / Market volatility"
              value={reasonInput}
              onChange={(e) => setReasonInput(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: 'var(--input-bg, #0e1117)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                color: 'var(--text)',
                fontSize: 13,
                marginBottom: 20,
                boxSizing: 'border-box',
              }}
            />

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="btn secondary" onClick={onClose} disabled={isToggling}>
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={isToggling}
                onClick={() => onToggle(true, reasonInput.trim() || 'Manual emergency lock engaged via UI')}
                style={{
                  backgroundColor: 'var(--danger)',
                  borderColor: 'var(--danger)',
                  color: '#fff',
                  fontWeight: 600,
                }}
              >
                {isToggling ? 'Locking…' : 'Engage Emergency Kill Switch'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
