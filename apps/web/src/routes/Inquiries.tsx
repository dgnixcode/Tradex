import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchInquiries, updateInquiryStatus } from '../api.ts';
import type { InquiryItem, InquiryStatus } from '../api.ts';

export function Inquiries() {
  const queryClient = useQueryClient();
  const [selectedStatus, setSelectedStatus] = useState<InquiryStatus | 'all'>('all');
  const [search, setSearch] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['inquiries'],
    queryFn: () => fetchInquiries(),
    refetchInterval: 15000,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: InquiryStatus }) =>
      updateInquiryStatus(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inquiries'] });
    },
  });

  const inquiries = data?.inquiries ?? [];

  // Filtered by status and search
  const filtered = inquiries.filter((item) => {
    if (selectedStatus !== 'all' && item.status !== selectedStatus) return false;
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      const matchName = item.name.toLowerCase().includes(q);
      const matchEmail = item.email.toLowerCase().includes(q);
      const matchPhone = item.phone.toLowerCase().includes(q);
      const matchExchange = item.exchange.toLowerCase().includes(q);
      const matchNotes = (item.notes ?? '').toLowerCase().includes(q);
      return matchName || matchEmail || matchPhone || matchExchange || matchNotes;
    }
    return true;
  });

  // Summary counts
  const totalCount = inquiries.length;
  const newCount = inquiries.filter((i) => i.status === 'new').length;
  const contactedCount = inquiries.filter((i) => i.status === 'contacted').length;
  const onboardedCount = inquiries.filter((i) => i.status === 'onboarded').length;

  const cleanPhoneForWa = (rawPhone: string): string => {
    const digits = rawPhone.replace(/\D/g, '');
    // If 10 digits without country code, assume India (+91)
    if (digits.length === 10) return `91${digits}`;
    return digits;
  };

  const formatDate = (isoString: string): string => {
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString('en-IN', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  const getStatusBadge = (status: InquiryStatus) => {
    switch (status) {
      case 'new':
        return <span className="status-badge-funded" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', borderColor: 'rgba(59, 130, 246, 0.35)' }}>New Lead</span>;
      case 'contacted':
        return <span className="status-badge-funded" style={{ background: 'rgba(234, 179, 8, 0.15)', color: '#eab308', borderColor: 'rgba(234, 179, 8, 0.35)' }}>Contacted</span>;
      case 'onboarded':
        return <span className="status-badge-funded">Onboarded</span>;
      case 'archived':
        return <span className="status-badge-skipped">Archived</span>;
    }
  };

  return (
    <div className="full-width-page" style={{ maxWidth: '1280px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap', gap: '14px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 800 }}>Client Inquiries</h1>
            {newCount > 0 && (
              <span className="rung-badge" style={{ color: '#16a34a', borderColor: 'rgba(22, 163, 74, 0.4)', background: 'rgba(22, 163, 74, 0.12)' }}>
                {newCount} New
              </span>
            )}
          </div>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: '13.5px' }}>
            Prospective wealth management investors requesting advisory consultation from the public site.
          </p>
        </div>

        <button
          type="button"
          onClick={() => refetch()}
          className="btn secondary btn-sm"
          style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Summary KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        <div className="panel" style={{ padding: '14px 16px', marginBottom: 0 }}>
          <span className="muted" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total Inquiries</span>
          <div style={{ fontSize: '24px', fontWeight: 800, marginTop: '2px', color: 'var(--text)' }}>{totalCount}</div>
        </div>
        <div className="panel" style={{ padding: '14px 16px', marginBottom: 0, borderColor: newCount > 0 ? 'rgba(59, 130, 246, 0.4)' : undefined }}>
          <span className="muted" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>New / Pending</span>
          <div style={{ fontSize: '24px', fontWeight: 800, marginTop: '2px', color: '#3b82f6' }}>{newCount}</div>
        </div>
        <div className="panel" style={{ padding: '14px 16px', marginBottom: 0 }}>
          <span className="muted" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>In Discussion</span>
          <div style={{ fontSize: '24px', fontWeight: 800, marginTop: '2px', color: '#eab308' }}>{contactedCount}</div>
        </div>
        <div className="panel" style={{ padding: '14px 16px', marginBottom: 0 }}>
          <span className="muted" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Onboarded</span>
          <div style={{ fontSize: '24px', fontWeight: 800, marginTop: '2px', color: 'var(--ok)' }}>{onboardedCount}</div>
        </div>
      </div>

      {/* Search and Tabs Bar */}
      <div className="panel" style={{ padding: '14px 16px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div className="account-nav-tabs" style={{ margin: 0, borderBottom: 'none', overflowX: 'auto', flexWrap: 'nowrap' }}>
            {(['all', 'new', 'contacted', 'onboarded', 'archived'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`account-nav-tab ${selectedStatus === tab ? 'active' : ''}`}
                onClick={() => setSelectedStatus(tab)}
                style={{ padding: '6px 12px', fontSize: '12.5px', textTransform: 'capitalize', whiteSpace: 'nowrap' }}
              >
                {tab === 'all' ? `All (${totalCount})` : tab}
                {tab === 'new' && newCount > 0 && (
                  <span className="account-tab-badge" style={{ background: 'rgba(59, 130, 246, 0.2)', color: '#3b82f6' }}>
                    {newCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div style={{ position: 'relative', width: '100%', maxWidth: '280px' }}>
            <input
              type="text"
              placeholder="Search name, phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="card-account-search"
              style={{ width: '100%', padding: '7px 12px', fontSize: '13px', boxSizing: 'border-box' }}
            />
          </div>
        </div>
      </div>

      {/* Table & Mobile Cards Container */}
      <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: 'var(--muted)' }}>
            Loading consultation inquiries...
          </div>
        ) : isError ? (
          <div style={{ padding: '48px', textAlign: 'center', color: 'var(--danger)' }}>
            Failed to load inquiries. Please check network connection and try again.
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '48px', textAlign: 'center', color: 'var(--muted)' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4, marginBottom: '12px' }}>
              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
              <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            </svg>
            <p style={{ margin: 0, fontSize: '15px' }}>
              {search ? 'No inquiries matching your search.' : 'No consultation inquiries in this category.'}
            </p>
          </div>
        ) : (
          <>
            {/* Desktop Table View (> 768px) */}
            <div className="table-scroll-container desktop-pos-table" style={{ maxHeight: 'calc(100vh - 360px)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13.5px' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)', color: 'var(--muted)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    <th style={{ padding: '14px 18px' }}>Date</th>
                    <th style={{ padding: '14px 18px' }}>Investor</th>
                    <th style={{ padding: '14px 18px' }}>Contact Details</th>
                    <th style={{ padding: '14px 18px' }}>Capital &amp; Venue</th>
                    <th style={{ padding: '14px 18px' }}>Channel / Notes</th>
                    <th style={{ padding: '14px 18px' }}>Status</th>
                    <th style={{ padding: '14px 18px', textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item: InquiryItem) => {
                    const waNumber = cleanPhoneForWa(item.phone);
                    const waText = encodeURIComponent(`Hello ${item.name}, I am reaching out regarding your wealth consultation request on Aza WealthKare.`);
                    const waUrl = `https://wa.me/${waNumber}?text=${waText}`;

                    return (
                      <tr key={item.id} style={{ borderBottom: '1px solid var(--line)', verticalAlign: 'top' }}>
                        <td style={{ padding: '14px 18px', whiteSpace: 'nowrap', color: 'var(--muted)', fontSize: '12px' }}>
                          {formatDate(item.createdAt)}
                        </td>

                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ fontWeight: 700, color: 'var(--text)' }}>{item.name}</div>
                        </td>

                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{item.phone}</span>
                              <a
                                href={waUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn btn-sm"
                                style={{
                                  padding: '2px 8px',
                                  fontSize: '11px',
                                  background: '#25D366',
                                  color: '#ffffff',
                                  border: 'none',
                                  borderRadius: '4px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  textDecoration: 'none',
                                }}
                                title="Chat on WhatsApp"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg> WhatsApp
                              </a>
                            </div>
                            <a
                              href={`mailto:${item.email}`}
                              style={{ color: 'var(--accent)', fontSize: '12px' }}
                            >
                              {item.email}
                            </a>
                          </div>
                        </td>

                        <td style={{ padding: '14px 18px' }}>
                          <div style={{ fontWeight: 600 }}>{item.capital}</div>
                          <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '2px' }}>
                            {item.exchange}
                          </div>
                        </td>

                        <td style={{ padding: '14px 18px', maxWidth: '280px' }}>
                          <span className="pill" style={{ fontSize: '11px', marginBottom: '4px', display: 'inline-block' }}>
                            {item.method}
                          </span>
                          {item.notes ? (
                            <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.4, marginTop: '4px', background: 'rgba(255,255,255,0.03)', padding: '6px 8px', borderRadius: '6px' }}>
                              "{item.notes}"
                            </div>
                          ) : (
                            <span style={{ fontSize: '12px', color: 'var(--faint)', display: 'block', marginTop: '4px' }}>No notes provided</span>
                          )}
                        </td>

                        <td style={{ padding: '14px 18px' }}>
                          {getStatusBadge(item.status)}
                        </td>

                        <td style={{ padding: '14px 18px', textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                            {item.status !== 'contacted' && item.status !== 'onboarded' && (
                              <button
                                type="button"
                                onClick={() => updateMutation.mutate({ id: item.id, status: 'contacted' })}
                                disabled={updateMutation.isPending}
                                className="btn secondary btn-sm"
                                style={{ fontSize: '11.5px', padding: '4px 8px' }}
                              >
                                Mark Contacted
                              </button>
                            )}
                            {item.status !== 'onboarded' && (
                              <button
                                type="button"
                                onClick={() => updateMutation.mutate({ id: item.id, status: 'onboarded' })}
                                disabled={updateMutation.isPending}
                                className="btn btn-sm"
                                style={{ fontSize: '11.5px', padding: '4px 8px', background: '#16a34a', color: '#fff', borderColor: '#16a34a' }}
                              >
                                Onboard
                              </button>
                            )}
                            {item.status !== 'archived' && (
                              <button
                                type="button"
                                onClick={() => updateMutation.mutate({ id: item.id, status: 'archived' })}
                                disabled={updateMutation.isPending}
                                className="btn secondary btn-sm"
                                style={{ fontSize: '11.5px', padding: '4px 8px', opacity: 0.6 }}
                              >
                                Archive
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Inquiry Cards (<= 768px) */}
            <div className="mobile-pos-cards">
              {filtered.map((item: InquiryItem) => {
                const waNumber = cleanPhoneForWa(item.phone);
                const waText = encodeURIComponent(`Hello ${item.name}, I am reaching out regarding your wealth consultation request on Aza WealthKare.`);
                const waUrl = `https://wa.me/${waNumber}?text=${waText}`;

                return (
                  <div key={`mobile-${item.id}`} className="pos-mobile-card">
                    <div className="pos-mobile-card-top">
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>{item.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{formatDate(item.createdAt)}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {getStatusBadge(item.status)}
                      </div>
                    </div>

                    <div className="pos-mobile-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      <div className="pos-mobile-cell">
                        <span className="pos-mobile-label">Capital</span>
                        <span className="pos-mobile-val" style={{ fontWeight: 700 }}>{item.capital}</span>
                      </div>
                      <div className="pos-mobile-cell">
                        <span className="pos-mobile-label">Exchange</span>
                        <span className="pos-mobile-val">{item.exchange}</span>
                      </div>
                    </div>

                    {item.notes && (
                      <div style={{ fontSize: 12, color: 'var(--text-dim)', background: 'rgba(255,255,255,0.03)', padding: '8px 10px', borderRadius: 6, fontStyle: 'italic' }}>
                        "{item.notes}"
                      </div>
                    )}

                    {/* 1-Tap Touch Contact Buttons */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <a
                        href={waUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-sm"
                        style={{
                          background: '#25D366',
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: 8,
                          padding: '8px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6,
                          fontWeight: 700,
                          fontSize: 12.5,
                          textDecoration: 'none',
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg> WhatsApp
                      </a>
                      <a
                        href={`tel:${item.phone}`}
                        className="btn btn-sm secondary"
                        style={{
                          borderRadius: 8,
                          padding: '8px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6,
                          fontWeight: 700,
                          fontSize: 12.5,
                          textDecoration: 'none',
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> Call
                      </a>
                    </div>

                    <a
                      href={`mailto:${item.email}`}
                      style={{ fontSize: 12, color: 'var(--accent)', textAlign: 'center', textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> {item.email}
                    </a>

                    {/* Status Action Buttons */}
                    <div style={{ display: 'flex', gap: 6, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
                      {item.status !== 'contacted' && item.status !== 'onboarded' && (
                        <button
                          type="button"
                          onClick={() => updateMutation.mutate({ id: item.id, status: 'contacted' })}
                          disabled={updateMutation.isPending}
                          className="btn secondary btn-sm"
                          style={{ flex: 1, fontSize: 11.5, padding: '6px' }}
                        >
                          Mark Contacted
                        </button>
                      )}
                      {item.status !== 'onboarded' && (
                        <button
                          type="button"
                          onClick={() => updateMutation.mutate({ id: item.id, status: 'onboarded' })}
                          disabled={updateMutation.isPending}
                          className="btn btn-sm"
                          style={{ flex: 1, fontSize: 11.5, padding: '6px', background: '#16a34a', color: '#fff', borderColor: '#16a34a' }}
                        >
                          Onboard
                        </button>
                      )}
                      {item.status !== 'archived' && (
                        <button
                          type="button"
                          onClick={() => updateMutation.mutate({ id: item.id, status: 'archived' })}
                          disabled={updateMutation.isPending}
                          className="btn secondary btn-sm"
                          style={{ fontSize: 11.5, padding: '6px 10px', opacity: 0.6 }}
                        >
                          Archive
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
