import { useEffect, useState } from 'react';
import { ShieldCheck, Loader2, AlertTriangle } from 'lucide-react';
import { getHybridStatus, type HybridStatus } from '@/lib/hybrid-auto-trade-api';

function StatusCell({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'neutral' }) {
  const color = tone === 'ok' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-foreground';
  return (
    <div className="rounded-xl border border-card-border bg-background p-2.5 sm:p-3">
      <p className="text-[11px] sm:text-xs text-muted-foreground">{label}</p>
      <p className={['mt-1 text-sm sm:text-base font-bold break-all', color].join(' ')}>{value}</p>
    </div>
  );
}

export default function HybridAutoTradePanel() {
  const [status, setStatus] = useState<HybridStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try { setStatus(await getHybridStatus()); setError(null); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(t);
  }, []);

  const running = status?.running === true;
  const circuitOk = status?.circuit === 'ACTIVE' || status?.circuit == null;
  const killOn = status?.kill === true;

  return (
    <div className="space-y-3 sm:space-y-4">
      <section className="rounded-2xl border border-primary/20 bg-primary/5 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 className="text-sm sm:text-base font-bold">Hybrid 선물 그리드</h2>
            <span className={['ml-2 rounded-full px-2.5 py-0.5 text-[11px] sm:text-xs font-bold',
              running ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border border-card-border bg-background text-muted-foreground'].join(' ')}>
              {running ? `작동 중 · ${status?.mode ?? ''}` : '정지'}
            </span>
          </div>
          <button type="button" onClick={refresh} disabled={loading}
            className="min-h-9 rounded-lg border border-card-border bg-background px-3 text-xs font-semibold disabled:opacity-50">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '새로고침'}
          </button>
        </div>
        {error ? <p className="mt-2 flex items-center gap-1 break-keep text-xs text-amber-700"><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}</p> : null}
      </section>

      <section className="rounded-2xl border border-card-border bg-card p-3 sm:p-4">
        <h3 className="text-sm font-bold">현재 상태</h3>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <StatusCell label="일일 PnL" value={`$${status?.dailyPnlUsd.toFixed(2) ?? '0.00'}`} tone={(status?.dailyPnlUsd ?? 0) >= 0 ? 'ok' : 'warn'} />
          <StatusCell label="주간 PnL" value={`$${status?.weeklyPnlUsd.toFixed(2) ?? '0.00'}`} tone={(status?.weeklyPnlUsd ?? 0) >= 0 ? 'ok' : 'warn'} />
          <StatusCell label="MDD" value={`${status?.currentDrawdownPercent.toFixed(2) ?? '0'}%`} tone={(status?.currentDrawdownPercent ?? 0) > 20 ? 'warn' : 'ok'} />
          <StatusCell label="포지션" value={`${status?.positionsCount ?? 0} / 4`} />
          <StatusCell label="Circuit" value={status?.circuit ?? 'ACTIVE'} tone={circuitOk ? 'ok' : 'warn'} />
          <StatusCell label="Kill" value={killOn ? '발동' : '정상'} tone={killOn ? 'warn' : 'ok'} />
          <StatusCell label="자본" value={status?.capitalUsd ? `$${status.capitalUsd}` : '—'} />
          <StatusCell label="심볼" value={status?.symbols.length ? `${status.symbols.length}개` : '—'} />
        </div>
      </section>
    </div>
  );
}
