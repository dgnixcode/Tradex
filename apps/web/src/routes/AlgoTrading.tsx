import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchAlgoStrategies,
  createAlgoStrategy,
  updateAlgoStrategy,
  deleteAlgoStrategy,
  startAlgoStrategy,
  pauseAlgoStrategy,
  stopAlgoStrategy,
  runAlgoStrategyOnce,
  fetchAlgoRuns,
  emergencyStopAllAlgos,
  runAlgoBacktest,
  fetchAlgoTemplates,
  fetchGroups,
  fetchAccounts,
} from '../api.ts';
import type {
  AlgoStrategy,
  AlgoStrategyInput,
  AlgoRun,
  BacktestResult,
} from '../api.ts';

const POPULAR_PAIRS = [
  'B-BTC_USDT',
  'B-ETH_USDT',
  'B-SOL_USDT',
  'B-XRP_USDT',
  'B-BNB_USDT',
  'B-DOGE_USDT',
  'B-ADA_USDT',
  'B-AVAX_USDT',
  'B-LINK_USDT',
  'B-SUI_USDT',
];

const TIMEFRAMES = [
  { label: '1 min', value: '1m' },
  { label: '5 min', value: '5m' },
  { label: '15 min', value: '15m' },
  { label: '30 min', value: '30m' },
  { label: '1 hour', value: '1h' },
  { label: '4 hours', value: '4h' },
  { label: '1 day', value: '1d' },
];

const INTERVALS = [
  { label: 'Every 1 minute', value: '1m' },
  { label: 'Every 5 minutes', value: '5m' },
  { label: 'Every 15 minutes', value: '15m' },
  { label: 'Every 30 minutes', value: '30m' },
  { label: 'Every 1 hour', value: '1h' },
  { label: 'Every 4 hours', value: '4h' },
  { label: 'Every 1 day', value: '1d' },
  { label: 'Manual Trigger Only', value: 'manual' },
];

export function AlgoTrading() {
  const queryClient = useQueryClient();

  // Queries
  const strategiesQuery = useQuery({
    queryKey: ['algo', 'strategies'],
    queryFn: fetchAlgoStrategies,
    refetchInterval: 5000,
  });

  const templatesQuery = useQuery({
    queryKey: ['algo', 'templates'],
    queryFn: fetchAlgoTemplates,
    staleTime: 60_000,
  });

  const groupsQuery = useQuery({
    queryKey: ['groups'],
    queryFn: fetchGroups,
  });

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  // Selected Strategy ID
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Strategy list filters
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused' | 'stopped'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Active Tab: editor | params | backtest | logs
  const [activeTab, setActiveTab] = useState<'editor' | 'params' | 'backtest' | 'logs'>('editor');

  // Form State for Active Strategy
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetType, setTargetType] = useState<'account' | 'group'>('group');
  const [targetId, setTargetId] = useState('');
  const [pair, setPair] = useState('B-BTC_USDT');
  const [timeframe, setTimeframe] = useState('5m');
  const [scheduleInterval, setScheduleInterval] = useState<'1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | 'manual'>('5m');
  const [isDryRun, setIsDryRun] = useState(true);
  const [script, setScript] = useState('');
  const [paramsJson, setParamsJson] = useState('{}');
  const [isDirty, setIsDirty] = useState(false);

  // Backtest runner state
  const [backtestCandleLimit, setBacktestCandleLimit] = useState(300);
  const [backtestCapital, setBacktestCapital] = useState(10000);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [backtestError, setBacktestError] = useState<string | null>(null);

  // UI Modals
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isEmergencyModalOpen, setIsEmergencyModalOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [isSdkDocOpen, setIsSdkDocOpen] = useState(false);

  // Create Modal form state
  const [newStratName, setNewStratName] = useState('');
  const [newStratTemplateId, setNewStratTemplateId] = useState('');
  const [newStratTargetType, setNewStratTargetType] = useState<'group' | 'account'>('group');
  const [newStratTargetId, setNewStratTargetId] = useState('');

  const strategies = strategiesQuery.data ?? [];
  const templates = templatesQuery.data ?? [];
  const groups = groupsQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];

  const selectedStrategy = useMemo(() => {
    return strategies.find((s) => s.id === selectedId) ?? null;
  }, [strategies, selectedId]);

  // Runs query for selected strategy
  const runsQuery = useQuery({
    queryKey: ['algo', 'runs', selectedId],
    queryFn: () => (selectedId ? fetchAlgoRuns(selectedId) : Promise.resolve([])),
    enabled: Boolean(selectedId),
    refetchInterval: activeTab === 'logs' ? 3000 : false,
  });

  // Select first strategy on initial load if none selected
  useEffect(() => {
    if (!selectedId && strategies.length > 0) {
      setSelectedId(strategies[0]!.id);
    }
  }, [strategies, selectedId]);

  // Populate editor form when active strategy changes
  useEffect(() => {
    if (selectedStrategy) {
      setName(selectedStrategy.name);
      setDescription(selectedStrategy.description ?? '');
      setTargetType(selectedStrategy.targetType);
      setTargetId(selectedStrategy.targetId);
      setPair(selectedStrategy.pair);
      setTimeframe(selectedStrategy.timeframe);
      setScheduleInterval(selectedStrategy.scheduleInterval);
      setIsDryRun(selectedStrategy.isDryRun);
      setScript(selectedStrategy.script);
      setParamsJson(JSON.stringify(selectedStrategy.params, null, 2));
      setIsDirty(false);
      setBacktestResult(null);
      setBacktestError(null);
    }
  }, [selectedStrategy]);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Filtered strategies
  const filteredStrategies = useMemo(() => {
    return strategies.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (searchQuery.trim() !== '') {
        const q = searchQuery.toLowerCase();
        return s.name.toLowerCase().includes(q) || s.pair.toLowerCase().includes(q);
      }
      return true;
    });
  }, [strategies, statusFilter, searchQuery]);

  // Counts
  const counts = useMemo(() => {
    return {
      all: strategies.length,
      active: strategies.filter((s) => s.status === 'active').length,
      paused: strategies.filter((s) => s.status === 'paused').length,
      stopped: strategies.filter((s) => s.status === 'stopped').length,
    };
  }, [strategies]);

  // Mutations
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId) return;
      let parsedParams = {};
      try {
        parsedParams = JSON.parse(paramsJson);
      } catch {
        throw new Error('Parameters must be valid JSON');
      }

      const effectiveTargetId = targetId || (targetType === 'group' ? groups[0]?.id : accounts[0]?.id) || '';
      if (!effectiveTargetId) {
        throw new Error('Target group or account is required');
      }

      const input: Partial<AlgoStrategyInput> = {
        name,
        description: description.trim() !== '' ? description : null,
        targetType,
        targetId: effectiveTargetId,
        pair,
        timeframe,
        scheduleInterval,
        isDryRun,
        script,
        params: parsedParams,
      };

      return await updateAlgoStrategy(selectedId, input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['algo', 'strategies'] });
      setIsDirty(false);
      showToast('Strategy updated successfully', 'success');
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      let initialScript = `export default async function run({ market, positions, trade, log, params }) {\n  log("Executing algorithmic strategy cycle...");\n}`;
      let initialParams = {};
      let initialPair = 'B-BTC_USDT';
      let initialTimeframe = '5m';
      let initialInterval: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | 'manual' = '5m';

      if (newStratTemplateId) {
        const tmpl = templates.find((t) => t.id === newStratTemplateId);
        if (tmpl) {
          initialScript = tmpl.script;
          initialParams = tmpl.defaultParams;
          initialPair = tmpl.pair;
          initialTimeframe = tmpl.timeframe;
          initialInterval = tmpl.scheduleInterval;
        }
      }

      const effectiveTargetId = newStratTargetId || (newStratTargetType === 'group' ? groups[0]?.id : accounts[0]?.id) || '';
      if (!effectiveTargetId) {
        throw new Error('Please select a target group or account');
      }

      return await createAlgoStrategy({
        name: newStratName.trim(),
        targetType: newStratTargetType,
        targetId: effectiveTargetId,
        pair: initialPair,
        timeframe: initialTimeframe,
        scheduleInterval: initialInterval,
        script: initialScript,
        params: initialParams,
        isDryRun: true,
      });
    },
    onSuccess: (newStrat) => {
      queryClient.invalidateQueries({ queryKey: ['algo', 'strategies'] });
      setIsCreateModalOpen(false);
      setNewStratName('');
      setNewStratTemplateId('');
      setSelectedId(newStrat.id);
      showToast(`Strategy '${newStrat.name}' created`, 'success');
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return await deleteAlgoStrategy(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['algo', 'strategies'] });
      showToast('Strategy deleted', 'info');
      setSelectedId(null);
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    },
  });

  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'start' | 'pause' | 'stop' }) => {
      if (action === 'start') return await startAlgoStrategy(id);
      if (action === 'pause') return await pauseAlgoStrategy(id);
      return await stopAlgoStrategy(id);
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['algo', 'strategies'] });
      showToast(`Strategy ${vars.action === 'start' ? 'started' : vars.action === 'pause' ? 'paused' : 'stopped'}`, 'success');
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    },
  });

  const runOnceMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId) return;
      return await runAlgoStrategyOnce(selectedId, isDryRun ? 'dry_run' : 'live');
    },
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ['algo', 'strategies'] });
      queryClient.invalidateQueries({ queryKey: ['algo', 'runs', selectedId] });
      setActiveTab('logs');
      const statusText = run ? run.status : 'completed';
      showToast(`Strategy cycle executed (${statusText})`, statusText === 'completed' ? 'success' : 'error');
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    },
  });

  const emergencyStopMutation = useMutation({
    mutationFn: async () => {
      return await emergencyStopAllAlgos();
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['algo', 'strategies'] });
      setIsEmergencyModalOpen(false);
      showToast(`Emergency Stop triggered: ${res.stoppedCount} active strategies stopped immediately`, 'error');
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    },
  });

  // Handle template selection from inside editor
  const handleLoadTemplate = (templateId: string) => {
    const tmpl = templates.find((t) => t.id === templateId);
    if (!tmpl) return;
    if (confirm(`Load template '${tmpl.name}'? This will replace your current code and parameters in the editor.`)) {
      setScript(tmpl.script);
      setParamsJson(JSON.stringify(tmpl.defaultParams, null, 2));
      setPair(tmpl.pair);
      setTimeframe(tmpl.timeframe);
      setScheduleInterval(tmpl.scheduleInterval);
      setIsDirty(true);
      showToast(`Loaded '${tmpl.name}' template`, 'info');
    }
  };

  // Backtest execution
  const handleRunBacktest = async () => {
    setBacktestLoading(true);
    setBacktestError(null);
    let parsedParams = {};
    try {
      parsedParams = JSON.parse(paramsJson);
    } catch {
      setBacktestError('Invalid parameters JSON syntax');
      setBacktestLoading(false);
      return;
    }

    try {
      const res = await runAlgoBacktest({
        script,
        pair,
        timeframe,
        initialCapital: backtestCapital,
        candleLimit: backtestCandleLimit,
        params: parsedParams,
      });
      setBacktestResult(res);
      showToast('Backtest completed successfully', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBacktestError(msg);
      showToast(msg, 'error');
    } finally {
      setBacktestLoading(false);
    }
  };

  // Target label helper
  const getTargetName = (strat: AlgoStrategy) => {
    if (strat.targetType === 'group') {
      const g = groups.find((grp) => grp.id === strat.targetId);
      return g ? `Group: ${g.name}` : `Group (${strat.targetId.slice(0, 8)}...)`;
    }
    const a = accounts.find((acc) => acc.id === strat.targetId);
    return a ? `Account: ${a.name}` : `Account (${strat.targetId.slice(0, 8)}...)`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: '100vh', background: '#0a0a0c', color: '#f4f4f5' }}>
      {/* Toast Notification */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: 20,
            right: 20,
            zIndex: 9999,
            padding: '10px 16px',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
            background: toast.type === 'success' ? '#14532d' : toast.type === 'error' ? '#7f1d1d' : '#27272a',
            color: '#ffffff',
            border: `1px solid ${toast.type === 'success' ? '#22c55e' : toast.type === 'error' ? '#ef4444' : '#52525b'}`,
          }}
        >
          {toast.message}
        </div>
      )}

      {/* Top Header Bar */}
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '16px 24px',
          borderBottom: '1px solid #1f1f23',
          background: '#0e0e11',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', color: '#ffffff' }}>
              Algorithmic Trading Desk
            </h1>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 4,
                background: '#27272a',
                color: '#a1a1aa',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Engine Active
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#71717a', marginTop: 3 }}>
            Automated strategy scripting, backtesting simulation, and multi-account group execution
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {counts.active > 0 && (
            <button
              type="button"
              onClick={() => setIsEmergencyModalOpen(true)}
              style={{
                background: '#450a0a',
                color: '#f87171',
                border: '1px solid #991b1b',
                padding: '6px 14px',
                borderRadius: 5,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Emergency Stop All ({counts.active})
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              if (groups.length > 0 && !newStratTargetId) {
                setNewStratTargetId(groups[0]!.id);
              } else if (accounts.length > 0 && !newStratTargetId) {
                setNewStratTargetId(accounts[0]!.id);
              }
              setIsCreateModalOpen(true);
            }}
            style={{
              background: '#ffffff',
              color: '#000000',
              border: 'none',
              padding: '6px 16px',
              borderRadius: 5,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            + New Strategy
          </button>
        </div>
      </header>

      {/* Main Workspace: Left List + Right Studio */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left Pane: Strategies Directory */}
        <aside
          style={{
            width: 320,
            borderRight: '1px solid #1f1f23',
            background: '#0d0d10',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Search & Filter */}
          <div style={{ padding: '12px 14px', borderBottom: '1px solid #1f1f23', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              type="text"
              placeholder="Search strategies or pairs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                background: '#18181b',
                border: '1px solid #27272a',
                borderRadius: 5,
                padding: '6px 10px',
                fontSize: 12,
                color: '#ffffff',
                boxSizing: 'border-box',
                outline: 'none',
              }}
            />

            <div style={{ display: 'flex', gap: 4 }}>
              {(['all', 'active', 'paused', 'stopped'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  style={{
                    flex: 1,
                    padding: '4px 0',
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: 'capitalize',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                    background: statusFilter === st ? '#27272a' : 'transparent',
                    color: statusFilter === st ? '#ffffff' : '#71717a',
                  }}
                >
                  {st} ({counts[st]})
                </button>
              ))}
            </div>
          </div>

          {/* Strategy List */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filteredStrategies.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#71717a', fontSize: 13 }}>
                No strategies found
              </div>
            ) : (
              filteredStrategies.map((s) => {
                const isSelected = s.id === selectedId;
                const statusColor = s.status === 'active' ? '#22c55e' : s.status === 'paused' ? '#f59e0b' : '#71717a';

                return (
                  <div
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    style={{
                      padding: '12px 14px',
                      borderBottom: '1px solid #18181b',
                      background: isSelected ? '#18181b' : 'transparent',
                      cursor: 'pointer',
                      borderLeft: isSelected ? '3px solid #ffffff' : '3px solid transparent',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#f4f4f5' }}>{s.name}</span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: statusColor,
                          textTransform: 'uppercase',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor }} />
                        {s.status}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#a1a1aa', marginBottom: 6 }}>
                      <span style={{ fontWeight: 600, color: '#e4e4e7' }}>{s.pair}</span>
                      <span>·</span>
                      <span>{s.timeframe}</span>
                      <span>·</span>
                      <span
                        style={{
                          padding: '1px 5px',
                          borderRadius: 3,
                          fontSize: 10,
                          fontWeight: 600,
                          background: s.isDryRun ? '#1e3a8a' : '#7f1d1d',
                          color: s.isDryRun ? '#93c5fd' : '#fca5a5',
                        }}
                      >
                        {s.isDryRun ? 'DRY RUN' : 'LIVE REAL'}
                      </span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10.5, color: '#71717a' }}>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>
                        {getTargetName(s)}
                      </span>
                      <span>{s.lastRunAt ? new Date(s.lastRunAt).toLocaleTimeString() : 'Never run'}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Right Pane: Strategy Studio & Work Area */}
        {selectedStrategy ? (
          <main style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#09090b', overflow: 'hidden' }}>
            {/* Studio Header Bar */}
            <div
              style={{
                padding: '14px 20px',
                borderBottom: '1px solid #1f1f23',
                background: '#0d0d10',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setIsDirty(true);
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontSize: 16,
                    fontWeight: 700,
                    color: '#ffffff',
                    outline: 'none',
                    minWidth: 200,
                  }}
                />

                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: selectedStrategy.status === 'active' ? '#14532d' : '#27272a',
                    color: selectedStrategy.status === 'active' ? '#4ade80' : '#a1a1aa',
                  }}
                >
                  {selectedStrategy.status.toUpperCase()}
                </span>

                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: isDryRun ? '#1e3a8a' : '#7f1d1d',
                    color: isDryRun ? '#93c5fd' : '#fca5a5',
                  }}
                >
                  {isDryRun ? 'PAPER / DRY RUN' : 'REAL LIVE TRADING'}
                </span>
              </div>

              {/* Action Toolbar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {isDirty && (
                  <button
                    type="button"
                    onClick={() => saveMutation.mutate()}
                    disabled={saveMutation.isPending}
                    style={{
                      background: '#2563eb',
                      color: '#ffffff',
                      border: 'none',
                      padding: '6px 14px',
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {saveMutation.isPending ? 'Saving...' : 'Save Changes'}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => runOnceMutation.mutate()}
                  disabled={runOnceMutation.isPending}
                  style={{
                    background: '#27272a',
                    color: '#ffffff',
                    border: '1px solid #3f3f46',
                    padding: '6px 12px',
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {runOnceMutation.isPending ? 'Running...' : 'Run Once'}
                </button>

                {selectedStrategy.status !== 'active' ? (
                  <button
                    type="button"
                    onClick={() => toggleStatusMutation.mutate({ id: selectedStrategy.id, action: 'start' })}
                    style={{
                      background: '#16a34a',
                      color: '#ffffff',
                      border: 'none',
                      padding: '6px 14px',
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Start Strategy
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleStatusMutation.mutate({ id: selectedStrategy.id, action: 'pause' })}
                    style={{
                      background: '#d97706',
                      color: '#ffffff',
                      border: 'none',
                      padding: '6px 14px',
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Pause
                  </button>
                )}

                {selectedStrategy.status !== 'stopped' && (
                  <button
                    type="button"
                    onClick={() => toggleStatusMutation.mutate({ id: selectedStrategy.id, action: 'stop' })}
                    style={{
                      background: '#3f3f46',
                      color: '#f4f4f5',
                      border: 'none',
                      padding: '6px 12px',
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Stop
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Delete strategy '${selectedStrategy.name}'?`)) {
                      deleteMutation.mutate(selectedStrategy.id);
                    }
                  }}
                  style={{
                    background: 'transparent',
                    color: '#ef4444',
                    border: '1px solid #7f1d1d',
                    padding: '6px 10px',
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Delete
                </button>
              </div>
            </div>

            {/* Strategy Configuration Ribbon */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '10px 20px',
                borderBottom: '1px solid #18181b',
                background: '#0a0a0c',
                flexWrap: 'wrap',
              }}
            >
              {/* Target Type & Target Dropdown */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: '#71717a' }}>Target:</span>
                <select
                  value={targetType}
                  onChange={(e) => {
                    const newType = e.target.value as 'account' | 'group';
                    setTargetType(newType);
                    if (newType === 'group' && groups.length > 0) setTargetId(groups[0]!.id);
                    if (newType === 'account' && accounts.length > 0) setTargetId(accounts[0]!.id);
                    setIsDirty(true);
                  }}
                  style={{
                    background: '#18181b',
                    color: '#e4e4e7',
                    border: '1px solid #27272a',
                    padding: '3px 8px',
                    fontSize: 11.5,
                    borderRadius: 4,
                  }}
                >
                  <option value="group">Account Group</option>
                  <option value="account">Individual Account</option>
                </select>

                <select
                  value={targetId}
                  onChange={(e) => {
                    setTargetId(e.target.value);
                    setIsDirty(true);
                  }}
                  style={{
                    background: '#18181b',
                    color: '#e4e4e7',
                    border: '1px solid #27272a',
                    padding: '3px 8px',
                    fontSize: 11.5,
                    borderRadius: 4,
                    maxWidth: 180,
                  }}
                >
                  {targetType === 'group'
                    ? groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name} ({g.memberCount} accs)
                        </option>
                      ))
                    : accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                </select>
              </div>

              {/* Pair */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: '#71717a' }}>Pair:</span>
                <select
                  value={pair}
                  onChange={(e) => {
                    setPair(e.target.value);
                    setIsDirty(true);
                  }}
                  style={{
                    background: '#18181b',
                    color: '#e4e4e7',
                    border: '1px solid #27272a',
                    padding: '3px 8px',
                    fontSize: 11.5,
                    borderRadius: 4,
                  }}
                >
                  {POPULAR_PAIRS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>

              {/* Timeframe */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: '#71717a' }}>Candle:</span>
                <select
                  value={timeframe}
                  onChange={(e) => {
                    setTimeframe(e.target.value);
                    setIsDirty(true);
                  }}
                  style={{
                    background: '#18181b',
                    color: '#e4e4e7',
                    border: '1px solid #27272a',
                    padding: '3px 8px',
                    fontSize: 11.5,
                    borderRadius: 4,
                  }}
                >
                  {TIMEFRAMES.map((tf) => (
                    <option key={tf.value} value={tf.value}>
                      {tf.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Interval */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: '#71717a' }}>Interval:</span>
                <select
                  value={scheduleInterval}
                  onChange={(e) => {
                    setScheduleInterval(e.target.value as typeof scheduleInterval);
                    setIsDirty(true);
                  }}
                  style={{
                    background: '#18181b',
                    color: '#e4e4e7',
                    border: '1px solid #27272a',
                    padding: '3px 8px',
                    fontSize: 11.5,
                    borderRadius: 4,
                  }}
                >
                  {INTERVALS.map((inv) => (
                    <option key={inv.value} value={inv.value}>
                      {inv.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Dry Run Toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, cursor: 'pointer', color: '#e4e4e7' }}>
                  <input
                    type="checkbox"
                    checked={isDryRun}
                    onChange={(e) => {
                      if (!e.target.checked) {
                        if (!confirm('WARNING: Turning off Dry Run enables LIVE REAL TRADING on exchange accounts. Do you wish to proceed?')) {
                          return;
                        }
                      }
                      setIsDryRun(e.target.checked);
                      setIsDirty(true);
                    }}
                  />
                  <span>Paper Trading (Dry Run)</span>
                </label>
              </div>

              {/* Template dropdown loader */}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <select
                  onChange={(e) => {
                    if (e.target.value) {
                      handleLoadTemplate(e.target.value);
                      e.target.value = '';
                    }
                  }}
                  defaultValue=""
                  style={{
                    background: '#18181b',
                    color: '#a1a1aa',
                    border: '1px solid #27272a',
                    padding: '3px 10px',
                    fontSize: 11,
                    borderRadius: 4,
                  }}
                >
                  <option value="" disabled>Load Strategy Template...</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Studio Navigation Tabs */}
            <div style={{ display: 'flex', borderBottom: '1px solid #1f1f23', background: '#0e0e11' }}>
              {[
                { key: 'editor', label: 'Script Code Editor' },
                { key: 'params', label: 'Parameters' },
                { key: 'backtest', label: 'Historical Backtest' },
                { key: 'logs', label: `Execution Telemetry (${runsQuery.data?.length ?? 0})` },
              ].map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key as typeof activeTab)}
                  style={{
                    padding: '10px 20px',
                    fontSize: 12.5,
                    fontWeight: 600,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    color: activeTab === tab.key ? '#ffffff' : '#71717a',
                    borderBottom: activeTab === tab.key ? '2px solid #ffffff' : '2px solid transparent',
                  }}
                >
                  {tab.label}
                </button>
              ))}

              <button
                type="button"
                onClick={() => setIsSdkDocOpen(!isSdkDocOpen)}
                style={{
                  marginLeft: 'auto',
                  marginRight: 16,
                  background: 'transparent',
                  border: 'none',
                  color: isSdkDocOpen ? '#ffffff' : '#a1a1aa',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {isSdkDocOpen ? 'Close SDK Docs' : 'SDK Reference'}
              </button>
            </div>

            {/* Tab Body */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
              {/* Tab 1: Code Editor */}
              {activeTab === 'editor' && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <textarea
                    value={script}
                    onChange={(e) => {
                      setScript(e.target.value);
                      setIsDirty(true);
                    }}
                    placeholder="// Write your JavaScript strategy script here..."
                    spellCheck={false}
                    style={{
                      flex: 1,
                      width: '100%',
                      background: '#09090b',
                      color: '#f4f4f5',
                      fontFamily: '"Fira Code", "Courier New", monospace',
                      fontSize: 13,
                      lineHeight: '1.6',
                      padding: 16,
                      border: 'none',
                      resize: 'none',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              )}

              {/* Tab 2: Strategy Parameters */}
              {activeTab === 'params' && (
                <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
                  <h3 style={{ margin: '0 0 8px 0', fontSize: 14, fontWeight: 600 }}>Strategy Runtime Parameters</h3>
                  <p style={{ margin: '0 0 16px 0', fontSize: 12, color: '#71717a' }}>
                    JSON key-value configuration injected into your script via the <code>params</code> object.
                  </p>
                  <textarea
                    value={paramsJson}
                    onChange={(e) => {
                      setParamsJson(e.target.value);
                      setIsDirty(true);
                    }}
                    rows={12}
                    spellCheck={false}
                    style={{
                      width: '100%',
                      maxWidth: 600,
                      background: '#18181b',
                      color: '#f4f4f5',
                      fontFamily: '"Fira Code", monospace',
                      fontSize: 13,
                      lineHeight: '1.5',
                      padding: 14,
                      border: '1px solid #27272a',
                      borderRadius: 6,
                      outline: 'none',
                    }}
                  />
                </div>
              )}

              {/* Tab 3: Historical Backtester */}
              {activeTab === 'backtest' && (
                <div style={{ flex: 1, padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {/* Backtest Controls */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 16,
                      background: '#121215',
                      padding: '12px 18px',
                      borderRadius: 8,
                      border: '1px solid #1f1f23',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 11, color: '#71717a', marginBottom: 3 }}>Lookback History</div>
                      <select
                        value={backtestCandleLimit}
                        onChange={(e) => setBacktestCandleLimit(Number(e.target.value))}
                        style={{ background: '#18181b', color: '#fff', border: '1px solid #27272a', padding: '5px 10px', borderRadius: 4, fontSize: 12 }}
                      >
                        <option value={100}>100 Candles</option>
                        <option value={200}>200 Candles</option>
                        <option value={300}>300 Candles (~25h on 5m)</option>
                        <option value={500}>500 Candles (~41h on 5m)</option>
                        <option value={1000}>1000 Candles (~3.5 days)</option>
                      </select>
                    </div>

                    <div>
                      <div style={{ fontSize: 11, color: '#71717a', marginBottom: 3 }}>Simulated Capital (USDT)</div>
                      <input
                        type="number"
                        value={backtestCapital}
                        onChange={(e) => setBacktestCapital(Number(e.target.value))}
                        style={{ width: 120, background: '#18181b', color: '#fff', border: '1px solid #27272a', padding: '5px 10px', borderRadius: 4, fontSize: 12 }}
                      />
                    </div>

                    <div style={{ marginLeft: 'auto' }}>
                      <button
                        type="button"
                        onClick={handleRunBacktest}
                        disabled={backtestLoading}
                        style={{
                          background: '#ffffff',
                          color: '#000000',
                          border: 'none',
                          padding: '7px 20px',
                          borderRadius: 5,
                          fontSize: 12.5,
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        {backtestLoading ? 'Simulating...' : 'Run Backtest'}
                      </button>
                    </div>
                  </div>

                  {backtestError && (
                    <div style={{ background: '#450a0a', border: '1px solid #991b1b', color: '#fca5a5', padding: '10px 14px', borderRadius: 6, fontSize: 12 }}>
                      {backtestError}
                    </div>
                  )}

                  {/* Backtest Results */}
                  {backtestResult && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      {/* Metric Stat Cards */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                        <div style={{ background: '#121215', padding: '12px 16px', borderRadius: 6, border: '1px solid #1f1f23' }}>
                          <div style={{ fontSize: 11, color: '#71717a' }}>Net Return</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: backtestResult.metrics.netProfit >= 0 ? '#22c55e' : '#ef4444', marginTop: 4 }}>
                            {backtestResult.metrics.netProfit >= 0 ? '+' : ''}${backtestResult.metrics.netProfit.toLocaleString()} ({backtestResult.metrics.netProfitPct}%)
                          </div>
                        </div>

                        <div style={{ background: '#121215', padding: '12px 16px', borderRadius: 6, border: '1px solid #1f1f23' }}>
                          <div style={{ fontSize: 11, color: '#71717a' }}>Win Rate</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#f4f4f5', marginTop: 4 }}>
                            {backtestResult.metrics.winRatePct}%
                          </div>
                          <div style={{ fontSize: 10.5, color: '#71717a', marginTop: 2 }}>
                            {backtestResult.metrics.winningTrades}W / {backtestResult.metrics.losingTrades}L
                          </div>
                        </div>

                        <div style={{ background: '#121215', padding: '12px 16px', borderRadius: 6, border: '1px solid #1f1f23' }}>
                          <div style={{ fontSize: 11, color: '#71717a' }}>Max Drawdown</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#f87171', marginTop: 4 }}>
                            {backtestResult.metrics.maxDrawdownPct}%
                          </div>
                        </div>

                        <div style={{ background: '#121215', padding: '12px 16px', borderRadius: 6, border: '1px solid #1f1f23' }}>
                          <div style={{ fontSize: 11, color: '#71717a' }}>Profit Factor</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#f4f4f5', marginTop: 4 }}>
                            {backtestResult.metrics.profitFactor}
                          </div>
                        </div>

                        <div style={{ background: '#121215', padding: '12px 16px', borderRadius: 6, border: '1px solid #1f1f23' }}>
                          <div style={{ fontSize: 11, color: '#71717a' }}>Total Trades</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#f4f4f5', marginTop: 4 }}>
                            {backtestResult.metrics.totalTrades}
                          </div>
                          <div style={{ fontSize: 10.5, color: '#71717a', marginTop: 2 }}>
                            Avg {backtestResult.metrics.avgTradeDurationMinutes} mins
                          </div>
                        </div>

                        <div style={{ background: '#121215', padding: '12px 16px', borderRadius: 6, border: '1px solid #1f1f23' }}>
                          <div style={{ fontSize: 11, color: '#71717a' }}>Final Balance</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#ffffff', marginTop: 4 }}>
                            ${backtestResult.metrics.finalCapital.toLocaleString()}
                          </div>
                        </div>
                      </div>

                      {/* Equity Curve SVG Chart */}
                      {backtestResult.equityCurve.length > 1 && (
                        <div style={{ background: '#121215', padding: 16, borderRadius: 8, border: '1px solid #1f1f23' }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: '#a1a1aa', marginBottom: 12 }}>
                            Equity Curve ($ USDT)
                          </div>
                          {(() => {
                            const curve = backtestResult.equityCurve;
                            let minEq = curve[0]?.equity ?? 0;
                            let maxEq = curve[0]?.equity ?? 0;
                            for (let i = 1; i < curve.length; i++) {
                              const eq = curve[i]!.equity;
                              if (eq < minEq) minEq = eq;
                              if (eq > maxEq) maxEq = eq;
                            }
                            const range = Math.max(1, maxEq - minEq);
                            const width = 800;
                            const height = 180;
                            const padding = 20;

                            const points = curve.map((c, idx) => {
                              const x = padding + (idx / (curve.length - 1)) * (width - padding * 2);
                              const y = height - padding - ((c.equity - minEq) / range) * (height - padding * 2);
                              return `${x},${y}`;
                            }).join(' ');

                            return (
                              <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 180, overflow: 'visible' }}>
                                <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#27272a" strokeWidth="1" />
                                <polyline
                                  fill="none"
                                  stroke={backtestResult.metrics.netProfit >= 0 ? '#22c55e' : '#ef4444'}
                                  strokeWidth="2"
                                  points={points}
                                />
                              </svg>
                            );
                          })()}
                        </div>
                      )}

                      {/* Simulated Trades Blotter */}
                      <div style={{ background: '#121215', borderRadius: 8, border: '1px solid #1f1f23', overflow: 'hidden' }}>
                        <div style={{ padding: '12px 16px', borderBottom: '1px solid #1f1f23', fontSize: 12, fontWeight: 600, color: '#a1a1aa' }}>
                          Simulated Trades Log ({backtestResult.trades.length})
                        </div>
                        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, textAlign: 'left' }}>
                            <thead>
                              <tr style={{ color: '#71717a', borderBottom: '1px solid #1f1f23', background: '#0e0e11' }}>
                                <th style={{ padding: '8px 12px' }}>Side</th>
                                <th style={{ padding: '8px 12px' }}>Entry</th>
                                <th style={{ padding: '8px 12px' }}>Exit</th>
                                <th style={{ padding: '8px 12px' }}>PnL ($)</th>
                                <th style={{ padding: '8px 12px' }}>PnL (%)</th>
                                <th style={{ padding: '8px 12px' }}>Reason</th>
                                <th style={{ padding: '8px 12px' }}>Time</th>
                              </tr>
                            </thead>
                            <tbody>
                              {backtestResult.trades.map((tr) => (
                                <tr key={tr.id} style={{ borderBottom: '1px solid #18181b' }}>
                                  <td style={{ padding: '8px 12px', fontWeight: 600, color: tr.side === 'long' ? '#22c55e' : '#ef4444' }}>
                                    {tr.side.toUpperCase()}
                                  </td>
                                  <td style={{ padding: '8px 12px' }}>{tr.entryPrice}</td>
                                  <td style={{ padding: '8px 12px' }}>{tr.exitPrice}</td>
                                  <td style={{ padding: '8px 12px', fontWeight: 600, color: tr.pnl >= 0 ? '#22c55e' : '#ef4444' }}>
                                    {tr.pnl >= 0 ? '+' : ''}${tr.pnl}
                                  </td>
                                  <td style={{ padding: '8px 12px', fontWeight: 600, color: tr.pnlPct >= 0 ? '#22c55e' : '#ef4444' }}>
                                    {tr.pnlPct >= 0 ? '+' : ''}{tr.pnlPct}%
                                  </td>
                                  <td style={{ padding: '8px 12px', color: '#a1a1aa' }}>{tr.exitReason}</td>
                                  <td style={{ padding: '8px 12px', color: '#71717a' }}>{new Date(tr.entryTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 4: Execution Telemetry & Logs */}
              {activeTab === 'logs' && (
                <div style={{ flex: 1, padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#f4f4f5' }}>Strategy Execution History & Real-Time Logs</div>
                    <button
                      type="button"
                      onClick={() => runsQuery.refetch()}
                      style={{ background: '#27272a', border: '1px solid #3f3f46', color: '#ffffff', padding: '4px 10px', borderRadius: 4, fontSize: 11 }}
                    >
                      Refresh Logs
                    </button>
                  </div>

                  {runsQuery.data && runsQuery.data.length > 0 ? (
                    runsQuery.data.map((r: AlgoRun) => (
                      <div key={r.id} style={{ background: '#121215', borderRadius: 6, border: '1px solid #1f1f23', padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                            <span
                              style={{
                                fontWeight: 700,
                                color: r.status === 'completed' ? '#22c55e' : '#ef4444',
                                textTransform: 'uppercase',
                              }}
                            >
                              [{r.status}]
                            </span>
                            <span style={{ color: '#a1a1aa' }}>{new Date(r.triggeredAt).toLocaleString()}</span>
                            <span
                              style={{
                                fontSize: 10,
                                padding: '1px 6px',
                                borderRadius: 3,
                                background: r.mode === 'live' ? '#7f1d1d' : '#1e3a8a',
                                color: '#ffffff',
                              }}
                            >
                              {r.mode.toUpperCase()}
                            </span>
                          </div>
                          {r.error && <span style={{ color: '#f87171', fontSize: 11 }}>{r.error}</span>}
                        </div>

                        {/* Raw Console Logs */}
                        <div
                          style={{
                            background: '#09090b',
                            borderRadius: 4,
                            padding: 10,
                            fontFamily: '"Fira Code", monospace',
                            fontSize: 11,
                            maxHeight: 180,
                            overflowY: 'auto',
                            color: '#d4d4d8',
                          }}
                        >
                          {r.logs && r.logs.length > 0 ? (
                            r.logs.map((l, i) => (
                              <div key={i} style={{ marginBottom: 3, color: l.level === 'error' ? '#f87171' : l.level === 'trade' ? '#60a5fa' : '#a1a1aa' }}>
                                <span style={{ color: '#52525b' }}>[{new Date(l.timestamp).toLocaleTimeString()}]</span>{' '}
                                {l.message}
                              </div>
                            ))
                          ) : (
                            <div style={{ color: '#52525b' }}>No console output recorded for this run</div>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: 32, textAlign: 'center', color: '#71717a', fontSize: 13 }}>
                      No execution logs found. Click "Run Once" to trigger a cycle.
                    </div>
                  )}
                </div>
              )}

              {/* Side Drawer: SDK Reference */}
              {isSdkDocOpen && (
                <aside
                  style={{
                    width: 340,
                    borderLeft: '1px solid #1f1f23',
                    background: '#0e0e11',
                    overflowY: 'auto',
                    padding: 16,
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: '#fff' }}>Strategy SDK Reference</div>
                    <button
                      type="button"
                      onClick={() => setIsSdkDocOpen(false)}
                      style={{ background: 'none', border: 'none', color: '#a1a1aa', cursor: 'pointer', fontSize: 13 }}
                    >
                      X
                    </button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div>
                      <div style={{ fontWeight: 600, color: '#60a5fa' }}>market.getPrice(pair)</div>
                      <div style={{ color: '#71717a', fontSize: 11 }}>Returns current mark price (number).</div>
                    </div>

                    <div>
                      <div style={{ fontWeight: 600, color: '#60a5fa' }}>market.getCandles(pair, tf, limit)</div>
                      <div style={{ color: '#71717a', fontSize: 11 }}>Returns array of OHLCV candles [&#123;open, high, low, close, volume, time&#125;].</div>
                    </div>

                    <div>
                      <div style={{ fontWeight: 600, color: '#60a5fa' }}>positions.get(pair)</div>
                      <div style={{ color: '#71717a', fontSize: 11 }}>Returns active position &#123;side: 'long'|'short', size, entryPrice&#125; or null.</div>
                    </div>

                    <div>
                      <div style={{ fontWeight: 600, color: '#60a5fa' }}>account.getBalance()</div>
                      <div style={{ color: '#71717a', fontSize: 11 }}>Returns &#123;freeMargin, totalEquity, currency&#125;.</div>
                    </div>

                    <div>
                      <div style={{ fontWeight: 600, color: '#34d399' }}>indicators</div>
                      <div style={{ color: '#71717a', fontSize: 11 }}>
                        <code>rsi(prices, 14)</code><br />
                        <code>ema(prices, 20)</code><br />
                        <code>sma(prices, 20)</code><br />
                        <code>macd(prices, 12, 26, 9)</code><br />
                        <code>bollingerBands(prices, 20, 2)</code><br />
                        <code>atr(candles, 14)</code><br />
                        <code>supertrend(candles, 10, 3)</code><br />
                        <code>stochastic(candles, 14, 3, 3)</code>
                      </div>
                    </div>

                    <div>
                      <div style={{ fontWeight: 600, color: '#f43f5e' }}>trade.buy(options)</div>
                      <div style={{ color: '#71717a', fontSize: 11 }}>
                        Opens long or closes short.<br />
                        Options: &#123;pair, percentBp, leverage, takeProfitPrice, stopLossPrice, trailingStopLoss&#125;.
                      </div>
                    </div>

                    <div>
                      <div style={{ fontWeight: 600, color: '#f43f5e' }}>trade.sell(options)</div>
                      <div style={{ color: '#71717a', fontSize: 11 }}>Opens short position.</div>
                    </div>

                    <div>
                      <div style={{ fontWeight: 600, color: '#f43f5e' }}>trade.close(pair)</div>
                      <div style={{ color: '#71717a', fontSize: 11 }}>Closes active futures positions on pair.</div>
                    </div>

                    <div>
                      <div style={{ fontWeight: 600, color: '#fbbf24' }}>log(message)</div>
                      <div style={{ color: '#71717a', fontSize: 11 }}>Records real-time telemetry log.</div>
                    </div>
                  </div>
                </aside>
              )}
            </div>
          </main>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#71717a', fontSize: 14 }}>
            Select a strategy from the left pane or click "+ New Strategy" to get started.
          </div>
        )}
      </div>

      {/* New Strategy Modal */}
      {isCreateModalOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              width: 440,
              background: '#121215',
              border: '1px solid #27272a',
              borderRadius: 8,
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#ffffff' }}>Create New Strategy</h2>

            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Strategy Name</label>
              <input
                type="text"
                placeholder="e.g. BTC RSI Reversion"
                value={newStratName}
                onChange={(e) => setNewStratName(e.target.value)}
                style={{
                  width: '100%',
                  background: '#18181b',
                  border: '1px solid #27272a',
                  color: '#fff',
                  padding: '8px 12px',
                  borderRadius: 5,
                  fontSize: 13,
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Starting Template</label>
              <select
                value={newStratTemplateId}
                onChange={(e) => setNewStratTemplateId(e.target.value)}
                style={{
                  width: '100%',
                  background: '#18181b',
                  border: '1px solid #27272a',
                  color: '#fff',
                  padding: '8px 12px',
                  borderRadius: 5,
                  fontSize: 13,
                  boxSizing: 'border-box',
                }}
              >
                <option value="">Blank Strategy</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.pair})
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Target Type</label>
                <select
                  value={newStratTargetType}
                  onChange={(e) => {
                    const t = e.target.value as 'group' | 'account';
                    setNewStratTargetType(t);
                    if (t === 'group' && groups.length > 0) setNewStratTargetId(groups[0]!.id);
                    if (t === 'account' && accounts.length > 0) setNewStratTargetId(accounts[0]!.id);
                  }}
                  style={{ width: '100%', background: '#18181b', border: '1px solid #27272a', color: '#fff', padding: '8px 10px', borderRadius: 5, fontSize: 12 }}
                >
                  <option value="group">Account Group</option>
                  <option value="account">Individual Account</option>
                </select>
              </div>

              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Destination</label>
                <select
                  value={newStratTargetId}
                  onChange={(e) => setNewStratTargetId(e.target.value)}
                  style={{ width: '100%', background: '#18181b', border: '1px solid #27272a', color: '#fff', padding: '8px 10px', borderRadius: 5, fontSize: 12 }}
                >
                  {newStratTargetType === 'group'
                    ? groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))
                    : accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(false)}
                style={{ background: 'transparent', color: '#a1a1aa', border: '1px solid #27272a', padding: '6px 14px', borderRadius: 4, fontSize: 12 }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => createMutation.mutate()}
                disabled={!newStratName.trim() || !newStratTargetId || createMutation.isPending}
                style={{
                  background: '#ffffff',
                  color: '#000000',
                  border: 'none',
                  padding: '6px 18px',
                  borderRadius: 4,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {createMutation.isPending ? 'Creating...' : 'Create Strategy'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Emergency Stop Modal */}
      {isEmergencyModalOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              width: 420,
              background: '#121215',
              border: '1px solid #7f1d1d',
              borderRadius: 8,
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#f87171' }}>
              Confirm Emergency Stop All
            </h2>
            <p style={{ margin: 0, fontSize: 13, color: '#d4d4d8', lineHeight: 1.5 }}>
              This will immediately halt all {counts.active} active algorithmic strategies across your accounts.
              Ongoing execution intervals will be terminated.
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                onClick={() => setIsEmergencyModalOpen(false)}
                style={{ background: 'transparent', color: '#a1a1aa', border: '1px solid #27272a', padding: '6px 14px', borderRadius: 4, fontSize: 12 }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => emergencyStopMutation.mutate()}
                disabled={emergencyStopMutation.isPending}
                style={{
                  background: '#dc2626',
                  color: '#ffffff',
                  border: 'none',
                  padding: '6px 18px',
                  borderRadius: 4,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {emergencyStopMutation.isPending ? 'Halting...' : 'HALT ALL STRATEGIES'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
