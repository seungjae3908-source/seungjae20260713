import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Power, RefreshCw, ShieldAlert } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

type Exchange = 'bitget' | 'upbit' | 'kiwoom';
type Policy = {
  mode: 'approval' | 'automatic';
  automaticEnabled: boolean;
  emergencyStopped: boolean;
  exchangeEnabled: Record<Exchange, boolean>;
  enabledAssets: Record<Exchange, string[]>;
  enabledStrategies: string[];
  totalCapitalKrw: number;
  maxOrderKrw: number;
  dailyLossLimitPercent: number;
  maxAssetPercent: number;
  maxOpenPositions: number;
  maxDailyOrders: number;
  maxConsecutiveLosses: number;
  bitgetLeverage: 2 | 3;
};

type Status = {
  policy: Policy;
  connections: Array<{
    exchange: Exchange; accountMode: 'paper' | 'mock' | 'live'; configured: boolean;
    lastVerifiedAt: string | null; lastErrorCode: string | null; credentialsExposed: false;
  }>;
  emergencyStopped: boolean;
  credentialVault: { encryptionConfigured: boolean; keyValueExposed: false };
  lastOrder: { exchange: Exchange; state: string; updatedAt: string; lastErrorCode: string | null } | null;
};

const EXCHANGE_LABELS: Record<Exchange, string> = {
  bitget: 'Bitget 선물', upbit: 'Upbit 원화 현물', kiwoom: 'Kiwoom 국내주식',
};

const DEFAULT_POLICY: Policy = {
  mode: 'approval', automaticEnabled: false, emergencyStopped: false,
  exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
  enabledAssets: { bitget: [], upbit: [], kiwoom: [] },
  enabledStrategies: [], totalCapitalKrw: 1_000_000, maxOrderKrw: 1_000_000,
  dailyLossLimitPercent: 5, maxAssetPercent: 30, maxOpenPositions: 5,
  maxDailyOrders: 10, maxConsecutiveLosses: 3, bitgetLeverage: 2,
};

export function TradeAutomationSettings({ fixture }: { fixture?: Status }) {
  const [status, setStatus] = useState<Status | null>(fixture ?? null);
  const [draft, setDraft] = useState<Policy>(fixture?.policy ?? DEFAULT_POLICY);
  const [loading, setLoading] = useState(!fixture);
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);

  async function load() {
    if (fixture) return;
    setLoading(true);
    try {
      const response = await authorizedFetch('/api/trade-automation/status');
      const payload = await response.json() as Status & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? '설정을 불러오지 못했습니다.');
      setStatus(payload); setDraft(payload.policy); setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '설정을 불러오지 못했습니다.');
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  function updateNumber(key: keyof Policy, value: string) {
    setDraft((current) => ({ ...current, [key]: Number(value) }));
  }

  function toggleExchange(exchange: Exchange) {
    setDraft((current) => ({
      ...current,
      exchangeEnabled: { ...current.exchangeEnabled, [exchange]: !current.exchangeEnabled[exchange] },
    }));
  }

  async function save(confirmed: boolean) {
    if (fixture) {
      setStatus((current) => current ? { ...current, policy: draft } : current);
      setMessage('테스트 설정이 저장되었습니다.'); setConfirming(false); return;
    }
    try {
      const response = await authorizedFetch('/api/trade-automation/policy', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, confirmation: { acknowledged: confirmed } }),
      });
      const payload = await response.json() as { policy?: Policy; error?: string };
      if (!response.ok || !payload.policy) throw new Error(payload.error ?? '저장하지 못했습니다.');
      setDraft(payload.policy); setStatus((current) => current ? { ...current, policy: payload.policy! } : current);
      setMessage('거래 설정을 저장했습니다.'); setConfirming(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : '저장하지 못했습니다.'); }
  }

  async function emergencyStop() {
    if (fixture) {
      setDraft((current) => ({ ...current, mode: 'approval', automaticEnabled: false, emergencyStopped: true,
        exchangeEnabled: { bitget: false, upbit: false, kiwoom: false } }));
      setMessage('비상정지: 신규 주문이 차단되었습니다.'); return;
    }
    const response = await authorizedFetch('/api/trade-automation/emergency-stop', { method: 'POST' });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setMessage(payload.error ?? '비상정지에 실패했습니다.'); return; }
    setDraft((current) => ({ ...current, mode: 'approval', automaticEnabled: false, emergencyStopped: true,
      exchangeEnabled: { bitget: false, upbit: false, kiwoom: false } }));
    setMessage('비상정지: 신규 주문이 차단되었습니다.');
  }

  const connections = Object.fromEntries((status?.connections ?? []).map((item) => [item.exchange, item])) as Partial<Record<Exchange, Status['connections'][number]>>;
  const activeExchanges = (Object.keys(draft.exchangeEnabled) as Exchange[]).filter((key) => draft.exchangeEnabled[key]);
  const needsConfirmation = draft.mode === 'automatic' || draft.automaticEnabled || activeExchanges.length > 0;

  return <section className="rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm" data-testid="trade-automation-settings">
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="text-sm font-extrabold">승인 주문 · 자동매매</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">기본값은 모두 OFF이며 AI 채팅은 주문 권한이 없습니다.</p></div>
      <button type="button" onClick={() => void load()} aria-label="거래 설정 새로고침" className="rounded-xl border border-card-border p-2"><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /></button>
    </div>

    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
      {(Object.keys(EXCHANGE_LABELS) as Exchange[]).map((exchange) => {
        const connection = connections[exchange];
        return <div key={exchange} className="rounded-2xl border border-card-border bg-background p-3" data-testid={`connection-${exchange}`}>
          <div className="flex items-center gap-2">{connection?.configured ? <CheckCircle2 className="h-4 w-4 text-positive" /> : <AlertTriangle className="h-4 w-4 text-warning" />}<span className="text-xs font-extrabold">{EXCHANGE_LABELS[exchange]}</span></div>
          <p className="mt-1 text-[11px] text-muted-foreground">{connection?.configured ? `${connection.accountMode === 'live' ? '실전' : connection.accountMode === 'mock' ? '모의' : 'Paper'} 연결됨` : '연결 안 됨'}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">키 값은 화면에 표시하지 않습니다.</p>
        </div>;
      })}
    </div>

    <div className="mt-4 grid grid-cols-2 gap-2">
      <ModeButton active={draft.mode === 'approval'} onClick={() => setDraft((value) => ({ ...value, mode: 'approval', automaticEnabled: false, exchangeEnabled: { bitget: false, upbit: false, kiwoom: false } }))} label="승인형 주문" detail="승인 후 실행" />
      <ModeButton active={draft.mode === 'automatic'} onClick={() => setDraft((value) => ({ ...value, mode: 'automatic', automaticEnabled: true }))} label="자동매매" detail="최종 확인 필수" />
    </div>

    <div className="mt-3 space-y-2">
      {(Object.keys(EXCHANGE_LABELS) as Exchange[]).map((exchange) => <button key={exchange} type="button" disabled={draft.mode !== 'automatic'} onClick={() => toggleExchange(exchange)} className="flex w-full items-center justify-between rounded-2xl border border-card-border bg-background p-3 disabled:opacity-50">
        <span className="text-xs font-extrabold">{EXCHANGE_LABELS[exchange]} 활성화</span><Switch active={draft.exchangeEnabled[exchange]} />
      </button>)}
    </div>

    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
      {(Object.keys(EXCHANGE_LABELS) as Exchange[]).map((exchange) => <label key={exchange} className="rounded-2xl border border-card-border bg-background p-3 text-xs font-extrabold">
        {EXCHANGE_LABELS[exchange]} 허용 자산
        <input aria-label={`${EXCHANGE_LABELS[exchange]} 허용 자산`} value={draft.enabledAssets[exchange].join(', ')}
          onChange={(event) => setDraft((value) => ({ ...value, enabledAssets: { ...value.enabledAssets,
            [exchange]: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) } }))}
          placeholder={exchange === 'kiwoom' ? '005930, 000660' : 'BTC, ETH'}
          className="mt-2 h-10 w-full rounded-xl border border-card-border bg-card px-2 text-xs" />
      </label>)}
    </div>

    <div className="mt-4 grid grid-cols-2 gap-2">
      <NumberField label="총 운용금액" value={draft.totalCapitalKrw} onChange={(value) => updateNumber('totalCapitalKrw', value)} suffix="원" />
      <NumberField label="1회 주문금액" value={draft.maxOrderKrw} onChange={(value) => updateNumber('maxOrderKrw', value)} suffix="원" />
      <NumberField label="최대 보유비중" value={draft.maxAssetPercent} onChange={(value) => updateNumber('maxAssetPercent', value)} suffix="%" />
      <NumberField label="일일 손실한도" value={draft.dailyLossLimitPercent} onChange={(value) => updateNumber('dailyLossLimitPercent', value)} suffix="%" />
      <NumberField label="동시 보유 수" value={draft.maxOpenPositions} onChange={(value) => updateNumber('maxOpenPositions', value)} suffix="개" />
      <NumberField label="일일 주문 수" value={draft.maxDailyOrders} onChange={(value) => updateNumber('maxDailyOrders', value)} suffix="회" />
      <NumberField label="연속 손실 제한" value={draft.maxConsecutiveLosses} onChange={(value) => updateNumber('maxConsecutiveLosses', value)} suffix="회" />
    </div>

    <label className="mt-3 block rounded-2xl border border-card-border bg-background p-3 text-xs font-extrabold">허용 전략
      <input aria-label="허용 전략" value={draft.enabledStrategies.join(', ')}
        onChange={(event) => setDraft((value) => ({ ...value, enabledStrategies: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) }))}
        placeholder="예: breakout-v1, trend-v2"
        className="mt-2 h-11 w-full rounded-xl border border-card-border bg-card px-3 text-sm" />
    </label>

    <label className="mt-3 block rounded-2xl border border-card-border bg-background p-3 text-xs font-extrabold">Bitget 레버리지
      <select aria-label="Bitget 레버리지" value={draft.bitgetLeverage} onChange={(event) => setDraft((value) => ({ ...value, bitgetLeverage: Number(event.target.value) === 3 ? 3 : 2 }))} className="mt-2 h-11 w-full rounded-xl border border-card-border bg-card px-3">
        <option value="2">2배 (기본)</option><option value="3">3배</option>
      </select>
    </label>

    <div className="mt-3 rounded-2xl border border-card-border bg-background p-3 text-xs">
      <p className="font-extrabold">마지막 주문 · 체결 · 오류</p>
      <p className="mt-1 text-muted-foreground" data-testid="last-trade-state">{status?.lastOrder ? `${EXCHANGE_LABELS[status.lastOrder.exchange]} · ${status.lastOrder.state}${status.lastOrder.lastErrorCode ? ` · ${status.lastOrder.lastErrorCode}` : ''}` : '주문 기록 없음'}</p>
    </div>

    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <button type="button" onClick={() => needsConfirmation ? setConfirming(true) : void save(false)} className="rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground">설정 저장</button>
      <button type="button" onClick={() => void emergencyStop()} className="flex items-center justify-center gap-2 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-extrabold text-destructive"><Power className="h-4 w-4" />긴급정지</button>
    </div>
    {message && <p role="status" className="mt-3 rounded-2xl bg-secondary p-3 text-xs font-bold">{message}</p>}

    {confirming && <div className="fixed inset-0 z-50 flex items-end bg-black/50 p-3 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="자동매매 최종 확인">
      <div className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-card p-5 shadow-2xl">
        <div className="flex items-center gap-2 text-destructive"><ShieldAlert className="h-6 w-6" /><h3 className="text-lg font-black">자동매매 최종 확인</h3></div>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="font-bold">실제 자금</dt><dd>{activeExchanges.some((key) => connections[key]?.accountMode === 'live') ? '사용 가능 — 서버 승인 게이트 필요' : 'Paper·모의만'}</dd>
          <dt className="font-bold">활성 거래소</dt><dd>{activeExchanges.map((key) => EXCHANGE_LABELS[key]).join(', ') || '없음'}</dd>
          <dt className="font-bold">허용 자산</dt><dd>{activeExchanges.flatMap((key) => draft.enabledAssets[key].map((asset) => `${EXCHANGE_LABELS[key]}:${asset}`)).join(', ') || '없음'}</dd>
          <dt className="font-bold">최대 주문</dt><dd>{draft.maxOrderKrw.toLocaleString('ko-KR')}원</dd>
          <dt className="font-bold">일일 손실</dt><dd>-{draft.dailyLossLimitPercent}% 도달 시 중지</dd>
          <dt className="font-bold">레버리지</dt><dd>Bitget {draft.bitgetLeverage}배</dd>
          <dt className="font-bold">허용 전략</dt><dd>{draft.enabledStrategies.join(', ') || '등록된 전략 없음'}</dd>
          <dt className="font-bold">긴급정지</dt><dd>설정 화면의 긴급정지 버튼</dd>
        </dl>
        <div className="mt-5 grid grid-cols-2 gap-2"><button type="button" onClick={() => setConfirming(false)} className="rounded-2xl border border-card-border px-4 py-3 font-extrabold">취소</button><button type="button" onClick={() => void save(true)} className="rounded-2xl bg-destructive px-4 py-3 font-extrabold text-white">위험 확인 및 저장</button></div>
      </div>
    </div>}
  </section>;
}

function ModeButton({ active, onClick, label, detail }: { active: boolean; onClick: () => void; label: string; detail: string }) {
  return <button type="button" onClick={onClick} className={cn('rounded-2xl border p-3 text-left', active ? 'border-primary bg-primary/10' : 'border-card-border bg-background')}><span className="block text-sm font-extrabold">{label}</span><span className="mt-1 block text-[11px] text-muted-foreground">{detail}</span></button>;
}

function Switch({ active }: { active: boolean }) {
  return <span className={cn('h-6 w-11 rounded-full p-1 transition-colors', active ? 'bg-primary' : 'bg-muted')}><span className={cn('block h-4 w-4 rounded-full bg-background transition-transform', active && 'translate-x-5')} /></span>;
}

function NumberField({ label, value, onChange, suffix }: { label: string; value: number; onChange: (value: string) => void; suffix: string }) {
  return <label className="rounded-2xl border border-card-border bg-background p-3 text-xs font-extrabold">{label}<span className="mt-2 flex items-center gap-1"><input type="number" min="0" value={value} onChange={(event) => onChange(event.target.value)} className="h-10 min-w-0 flex-1 rounded-xl border border-card-border bg-card px-2 text-right text-sm font-bold" /><span>{suffix}</span></span></label>;
}

export type { Status as TradeAutomationStatus };
