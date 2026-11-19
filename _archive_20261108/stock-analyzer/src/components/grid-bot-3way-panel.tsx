import { useCallback, useEffect, useState } from 'react';
import { GridBot3WayStats } from './grid-bot-3way-stats';
import { GridBot3WayBotCard, BotConfig } from './grid-bot-3way-botcard';
import { GridBot3WayStartModal } from './grid-bot-3way-startmodal';

type Regime = 'up' | 'side' | 'down';
type Snapshot = { symbol: string; score: number; reasons: string[]; manual: boolean };
type BotRuntime = {
  status: string; startedAt: number | null; stopReason: string | null;
  totalPnl?: number; totalPnlPct?: number; tradeCount?: number; winCount?: number;
  recommendation: Snapshot | null;
  pendingReentry: { symbol: string; score: number; reasons: string[] } | null;
  exitStreak: number; lastObservedRegime: Regime | null;
  config: BotConfig;
};

const DEFAULT_CONFIG: Record<Regime, BotConfig> = {
  up:   { symbol: '', capital: 100, gridCount: 10, gapPct: 0.5, slPct: 6, leverage: 5, reinvestRatio: 0.5, autoStopOnRegimeExit: true, exitConfirmScans: 3 },
  side: { symbol: '', capital: 100, gridCount: 12, gapPct: 0.3, slPct: 4, leverage: 5, reinvestRatio: 0.5, autoStopOnRegimeExit: true, exitConfirmScans: 3 },
  down: { symbol: '', capital: 100, gridCount: 10, gapPct: 0.5, slPct: 6, leverage: 5, reinvestRatio: 0.5, autoStopOnRegimeExit: true, exitConfirmScans: 3 },
};
const LABEL: Record<Regime, { emoji: string; text: string }> = {
  up:   { emoji: '🟢', text: '상승형' },
  side: { emoji: '🟡', text: '횡보형' },
  down: { emoji: '🔴', text: '하락형' },
};

export function GridBot3WayPanel() {
  const [runtime, setRuntime] = useState<Record<Regime, BotRuntime | null>>({ up: null, side: null, down: null });
  const [config, setConfig] = useState<Record<Regime, BotConfig>>(DEFAULT_CONFIG);
  const [candidates, setCandidates] = useState<Record<Regime, Snapshot | null>>({ up: null, side: null, down: null });
  const [activeTab, setActiveTab] = useState<Regime>('up');
  const [modalOpen, setModalOpen] = useState(false);
  const [scanner, setScanner] = useState<any>(null);

  const refresh = useCallback(async () => {
    const arr = await Promise.all(
      (['up','side','down'] as Regime[]).map(id => fetch(`/grid-bot/${id}`).then(r => r.ok ? r.json() : null).catch(() => null))
    );
    setRuntime({ up: arr[0], side: arr[1], down: arr[2] });
    try { setScanner(await fetch('/grid-bot/recommendations/status').then(r => r.json())); } catch {}
  }, []);

  useEffect(() => { refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [refresh]);

  const autoFill = async (regime: Regime) => {
    try {
      const d = await fetch(`/grid-bot/recommendations?regime=${regime}&limit=1`).then(r => r.json());
      const top = d.candidates?.[0];
      if (!top) { alert(`${LABEL[regime].text}: 조건 충족 종목 없음`); return; }
      setConfig(p => ({ ...p, [regime]: { ...p[regime], symbol: top.symbol } }));
      setCandidates(p => ({ ...p, [regime]: top }));
    } catch (e: any) { alert('자동입력 실패: ' + e?.message); }
  };

  const save = async (regime: Regime) => {
    try {
      const body = config[regime];
      if (!body.symbol) { alert('종목을 선택하세요'); return; }
      const r = await fetch(`/grid-bot/${regime}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json());
      if (!r.ok) { alert('저장 실패: ' + (r.error || 'unknown')); return; }
      await fetch(`/grid-bot/${regime}/stop`, { method: 'POST' });
      refresh();
      alert('저장 완료');
    } catch (e: any) { alert('저장 오류: ' + e?.message); }
  };

  const start = async (regime: Regime) => {
    const s = config[regime];
    if (!s.symbol) { alert(`${LABEL[regime].text}: 종목을 선택하거나 자동입력 하세요`); return; }
    const r = await fetch(`/grid-bot/${regime}/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    }).then(r => r.json());
    if (!r.ok) { alert('시작 실패: ' + (r.error || 'unknown')); return; }
    setModalOpen(false);
    refresh();
  };

  const stop = async (regime: Regime) => {
    await fetch(`/grid-bot/${regime}/stop`, { method: 'POST' }); refresh();
  };

  return (
    <div className="p-3 border border-card-border rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-base font-bold">3봇 자동매매</h2>
        <div className="text-[10px] text-muted-foreground">
          {scanner ? `스캔 ${scanner.ageSec}s · up ${scanner.counts.up} / side ${scanner.counts.side} / down ${scanner.counts.down}` : '대기'}
        </div>
      </div>

      <GridBot3WayStats bots={runtime} />

      <div className="flex gap-1 mb-3">
        {(['up','side','down'] as Regime[]).map(k => {
          const st = runtime[k]?.status ?? 'idle';
          const dot = st === 'running' ? '●' : st === 'stopped' ? '◼' : st === 'paused' ? '❚❚' : '○';
          const active = activeTab === k;
          return (
            <button key={k} onClick={() => setActiveTab(k)}
              className={`flex-1 py-2 text-xs rounded-t border-x border-t border-card-border ${active ? 'bg-accent/40 font-bold' : 'bg-background/60'}`}>
              <div>{LABEL[k].emoji} {LABEL[k].text}</div>
              <div className="text-[10px] text-muted-foreground">{dot}</div>
            </button>
          );
        })}
      </div>

      <GridBot3WayBotCard regime={activeTab}
        config={config[activeTab]}
        setConfig={(c) => setConfig(p => ({ ...p, [activeTab]: c }))}
        runtime={runtime[activeTab]}
        onAutoFill={() => autoFill(activeTab)}
        onSave={() => save(activeTab)}
        onStop={() => stop(activeTab)}
      />

      <button onClick={() => setModalOpen(true)}
        className="mt-3 w-full py-2 rounded bg-green-600 text-white font-bold text-sm">
        ▶ 작동 (봇 선택)
      </button>

      {modalOpen && (
        <GridBot3WayStartModal
          candidates={candidates}
          statuses={{ up: runtime.up?.status ?? 'idle', side: runtime.side?.status ?? 'idle', down: runtime.down?.status ?? 'idle' }}
          onStart={(regime) => { setActiveTab(regime); start(regime); }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
