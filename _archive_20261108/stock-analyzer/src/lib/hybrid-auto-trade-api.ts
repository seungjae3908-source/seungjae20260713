export interface HybridStatus {
  running: boolean;
  pid: number | null;
  mode: 'DRY_RUN' | 'LIVE' | null;
  symbols: readonly string[];
  capitalUsd: number | null;
  startedAt: string | null;
  lastLogLines: readonly string[];
  circuit: string;
  kill: boolean;
  dailyPnlUsd: number;
  weeklyPnlUsd: number;
  currentDrawdownPercent: number;
  positionsCount: number;
}

export interface StartInput {
  symbols: readonly string[];
  capitalUsd: number;
  dryRun: boolean;
  intervalMs?: number;
  granularity?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    ...init,
  });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP_${res.status}` }));
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP_${res.status}`);
  return body as T;
}

export async function getHybridStatus(): Promise<HybridStatus> {
  const r = await request<{ ok: true; status: HybridStatus }>('/api/hybrid-auto-trade/status');
  return r.status;
}

export async function startHybridWorker(input: StartInput): Promise<HybridStatus> {
  const r = await request<{ ok: true; status: HybridStatus }>('/api/hybrid-auto-trade/start', {
    method: 'POST', body: JSON.stringify(input),
  });
  return r.status;
}

export async function stopHybridWorker(): Promise<HybridStatus> {
  const r = await request<{ ok: true; status: HybridStatus }>('/api/hybrid-auto-trade/stop', { method: 'POST' });
  return r.status;
}
