import { useEffect, useState } from 'react';
import { SymbolAutocomplete } from './symbol-autocomplete';

type Regime = 'up' | 'side' | 'down';
export type BotConfig = {
  symbol: string; capital: number; gridCount: number; gapPct: number;
  slPct: number; leverage: number; reinvestRatio: number;
  autoStopOnRegimeExit: boolean; exitConfirmScans: number;
};
type BotRuntime = {
  status: string; startedAt: number | null; stopReason: string | null;
  totalPnl?: number; totalPnlPct?: number; tradeCount?: number; winCount?: number;
  recommendation: { symbol: string; score: number; reasons: string[]; manual: boolean } | null;
  pendingReentry: { symbol: string; score: number; reasons: string[] } | null;
  exitStreak: number; lastObservedRegime: Regime | null;
  config: BotConfig;
};
type Props = {
  regime: Regime; config: BotConfig; setConfig: (c: BotConfig) => void;
  runtime: BotRuntime | null; onAutoFill: () => void; onSave: () => void; onStop: () => void;
};
const LABEL: Record<Regime, { emoji: string; text: string; color: string }> = {
  up:   { emoji: '🟢', text: '상승형 봇', color: 'border-green-500/40' },
  side: { emoji: '🟡', text: '횡보형 봇', color: 'border-yellow-500/40' },
  down: { emoji: '🔴', text: '하락형 봇', color: 'border-red-500/40' },
};
const KRW = 1450;
const fmtUsd = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
const fmtKrw = (n: number) => `${Math.round(n * KRW).toLocaleString()}`;
function fmtRange(startedAt: number | null): string {
  if (!startedAt) return '—';
  const s = new Date(startedAt); const now = new Date();
  const day = Math.floor((now.getTime() - startedAt) / 86400000);
  return `${s.getFullYear()}.${s.getMonth()+1}.${s.getDate()}. ~ ${now.getFullYear()}.${now.getMonth()+1}.${now.getDate()}. (D+${day})`;
}

export function GridBot3WayBotCard({ regime, config, setConfig, runtime, onAutoFill, onSave, onStop }: Props) {
  const L = LABEL[regime];
  const [local, setLocal] = useState<BotConfig>(config);
  useEffect(() => setLocal(config), [config]);
  const isRunning = runtime?.status === 'running';
  const num = (k: keyof BotConfig) => (e: any) => setLocal({ ...local, [k]: Number(e.target.value) } as any);
  const dirty = JSON.stringify(local) !== JSON.stringify(config);

  return (
    <div className={`border-2 rounded-lg p-3 ${L.color} bg-background`}>
      <h3 className="font-bold mb-2">{L.emoji} {L.text}</h3>

      <div className="text-xs space-y-0.5 mb-3 px-2 py-1.5 rounded bg-background/60 border border-card-border">
        <div>작동: <span className="font-mono">{fmtRange(runtime?.startedAt ?? null)}</span></div>
        <div>수익률: <span className={`font-bold ${(runtime?.totalPnlPct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>{(runtime?.totalPnlPct ?? 0) >= 0 ? '+' : ''}{(runtime?.totalPnlPct ?? 0).toFixed(2)}%</span></div>
        <div>수익금: <span className={`font-bold ${(runtime?.totalPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmtUsd(runtime?.totalPnl ?? 0)} USD</span> <span className="text-muted-foreground">({fmtKrw(runtime?.totalPnl ?? 0)}원)</span></div>
        <div>거래: {runtime?.tradeCount ?? 0}회 · 승률: {runtime?.tradeCount ? Math.round(((runtime.winCount ?? 0) / runtime.tradeCount) * 100) : 0}%</div>
      </div>

      <div className="space-y-2 mb-2">
        <div>
          <label className="text-[11px] text-muted-foreground">종목 (crypto_futures)</label>
          <div className="flex gap-1 mt-0.5">
            <div className="flex-1">
              <SymbolAutocomplete value={local.symbol} market="crypto_futures"
                onChange={(sym: string) => setLocal({ ...local, symbol: sym })}
                className="w-full border border-card-border rounded bg-background px-2 py-1.5 text-sm text-foreground" />
            </div>
            <button onClick={onAutoFill} disabled={isRunning}
              className="px-2 py-1.5 text-xs rounded bg-blue-600 text-white font-bold disabled:opacity-40">🔄</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {([['capital','투입금'],['gridCount','그리드'],['gapPct','갭%'],['slPct','손절%'],['leverage','레버리지']] as const).map(([k,label]) => (
            <label key={k} className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">{label}</span>
              <input type="number" step={k==='gapPct'?0.1:1} disabled={isRunning}
                value={local[k] as number} onChange={num(k)}
                className="border border-card-border rounded bg-background px-1.5 py-0.5 text-xs text-foreground" />
            </label>
          ))}
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">복리%</span>
            <input type="number" step={1} disabled={isRunning}
              value={Math.round(local.reinvestRatio * 100)}
              onChange={(e) => setLocal({ ...local, reinvestRatio: Number(e.target.value) / 100 })}
              className="border border-card-border rounded bg-background px-1.5 py-0.5 text-xs text-foreground" />
          </label>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={local.autoStopOnRegimeExit} disabled={isRunning}
            onChange={(e) => setLocal({ ...local, autoStopOnRegimeExit: e.target.checked })} />
          <span>국면 이탈 {local.exitConfirmScans}회 시 자동 정지</span>
        </label>
      </div>

      {runtime?.recommendation && (
        <details className="mb-2 rounded border border-card-border bg-background/50">
          <summary className="cursor-pointer px-2 py-1 text-xs font-semibold">
            ❓ 왜 이 종목? <span className="text-green-400">{runtime.recommendation.score}점</span>
          </summary>
          <ul className="px-3 py-1.5 text-xs list-disc list-inside">
            {runtime.recommendation.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </details>
      )}

      {isRunning && runtime && (
        <div className="mb-2 px-2 py-1 rounded bg-green-500/10 text-[11px] text-green-300">
          감시중 · 이탈 {runtime.exitStreak}/{local.exitConfirmScans}
          {runtime.lastObservedRegime && ` · 관측 ${runtime.lastObservedRegime}`}
        </div>
      )}
      {runtime?.status === 'stopped' && runtime.pendingReentry && (
        <div className="mb-2 p-2 rounded bg-blue-500/15 border border-blue-500/30 text-xs">
          🔄 재진입 대기: <b>{runtime.pendingReentry.symbol}</b> ({runtime.pendingReentry.score}점)
        </div>
      )}
      {runtime?.status === 'stopped' && runtime.stopReason && !runtime.pendingReentry && (
        <div className="mb-2 px-2 py-1.5 rounded bg-red-500/20 text-red-300 text-[11px]">🚨 정지: {runtime.stopReason}</div>
      )}

      <div className="flex gap-1">
        <button onClick={onSave} disabled={!dirty || isRunning}
          className="flex-1 text-xs px-2 py-1.5 rounded bg-indigo-600 text-white font-bold disabled:opacity-40">저장</button>
        <button onClick={onStop} disabled={!isRunning}
          className="text-xs px-2 py-1.5 rounded bg-red-600 text-white disabled:opacity-40">⏹ 정지</button>
      </div>
    </div>
  );
}
