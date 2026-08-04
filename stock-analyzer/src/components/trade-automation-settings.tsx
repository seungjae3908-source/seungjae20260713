import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  LockKeyhole,
  Power,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

type Exchange = 'bitget' | 'upbit' | 'kiwoom';
type PilotStage = 'approval-20' | 'limited-50' | 'validated';
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
  riskOptimizationEnabled: boolean;
  pilotStage: PilotStage;
  riskPerTradePercent: Record<Exchange, number>;
  totalDailyLossLimitPercent: number;
  minExpectedValueR: number;
  minStrategySampleSize: number;
  minProfitFactor: number;
  maxStrategyDrawdownPercent: number;
  maxEstimatedSlippagePercent: number;
  maxAverageSpreadPercent: number;
  maxCorrelatedExposurePercent: number;
  maxEconomicsAgeHours: number;
};

type Status = {
  policy: Policy;
  connections: Array<{
    exchange: Exchange; accountMode: 'paper' | 'mock' | 'live'; configured: boolean;
    lastVerifiedAt: string | null; lastErrorCode: string | null; credentialsExposed: false;
  }>;
  emergencyStopped: boolean;
  liveExecutionServerEnabled?: Record<Exchange, boolean>;
  credentialVault: { encryptionConfigured: boolean; keyValueExposed: false };
  lastOrder: { exchange: Exchange; state: string; updatedAt: string; lastErrorCode: string | null } | null;
};

const EXCHANGE_LABELS: Record<Exchange, string> = {
  bitget: 'Bitget 선물', upbit: 'Upbit 원화 현물', kiwoom: 'Kiwoom 국내주식',
};

const PILOT_LABELS: Record<PilotStage, string> = {
  'approval-20': '1단계 · 첫 20건 승인형',
  'limited-50': '2단계 · 21~50건 제한형',
  validated: '3단계 · 실전 성과 검증완료',
};

const DEFAULT_POLICY: Policy = {
  mode: 'approval', automaticEnabled: false, emergencyStopped: false,
  exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
  enabledAssets: { bitget: [], upbit: [], kiwoom: [] },
  enabledStrategies: [], totalCapitalKrw: 1_000_000, maxOrderKrw: 1_000_000,
  dailyLossLimitPercent: 5, maxAssetPercent: 30, maxOpenPositions: 5,
  maxDailyOrders: 10, maxConsecutiveLosses: 3, bitgetLeverage: 2,
  riskOptimizationEnabled: true, pilotStage: 'approval-20',
  riskPerTradePercent: { bitget: 0.1, upbit: 0.2, kiwoom: 0.25 },
  totalDailyLossLimitPercent: 1, minExpectedValueR: 0.15,
  minStrategySampleSize: 50, minProfitFactor: 1.2, maxStrategyDrawdownPercent: 15,
  maxEstimatedSlippagePercent: 0.25, maxAverageSpreadPercent: 0.15,
  maxCorrelatedExposurePercent: 40, maxEconomicsAgeHours: 24,
};

export function TradeAutomationSettings({ fixture }: { fixture?: Status }) {
  const auth = useAuth();
  const authorized = Boolean(fixture) || auth.can('canManageMembers');
  const [status, setStatus] = useState<Status | null>(fixture ?? null);
  const [draft, setDraft] = useState<Policy>(fixture?.policy ?? DEFAULT_POLICY);
  const [loading, setLoading] = useState(!fixture && authorized);
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);

  async function load() {
    if (fixture || !authorized) return;
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
      const stopped = {
        ...draft, mode: 'approval' as const, automaticEnabled: false, emergencyStopped: true,
        exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
      };
      setDraft(stopped);
      setStatus((current) => current ? { ...current, emergencyStopped: true, policy: stopped } : current);
      setMessage('비상정지: 신규 주문이 차단되었습니다.'); return;
    }
    const response = await authorizedFetch('/api/trade-automation/emergency-stop', { method: 'POST' });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setMessage(payload.error ?? '비상정지에 실패했습니다.'); return; }
    const stopped = {
      ...draft, mode: 'approval' as const, automaticEnabled: false, emergencyStopped: true,
      exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
    };
    setDraft(stopped);
    setStatus((current) => current ? { ...current, emergencyStopped: true, policy: stopped } : current);
    setMessage('비상정지: 신규 주문이 차단되었습니다.');
  }

  async function resumeEvaluation() {
    if (fixture) {
      const resumed = {
        ...draft, mode: 'approval' as const, automaticEnabled: false, emergencyStopped: false,
        exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
      };
      setDraft(resumed);
      setStatus((current) => current ? { ...current, emergencyStopped: false, policy: resumed } : current);
      setMessage('정지를 해제했습니다. 자동매매는 OFF이며 새 신호부터 다시 평가합니다.'); return;
    }
    const response = await authorizedFetch('/api/trade-automation/resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'RESUME_NEW_ORDER_EVALUATION' }),
    });
    const payload = await response.json() as { policy?: Policy; error?: string };
    if (!response.ok || !payload.policy) {
      setMessage(payload.error ?? '정지 해제에 실패했습니다.'); return;
    }
    setDraft(payload.policy);
    setStatus((current) => current ? { ...current, emergencyStopped: false, policy: payload.policy! } : current);
    setMessage('정지를 해제했습니다. 자동매매는 OFF이며 새 신호부터 다시 평가합니다.');
  }

  const connections = Object.fromEntries((status?.connections ?? []).map((item) => [item.exchange, item])) as Partial<Record<Exchange, Status['connections'][number]>>;
  const activeExchanges = (Object.keys(draft.exchangeEnabled) as Exchange[]).filter((key) => draft.exchangeEnabled[key]);
  const needsConfirmation = draft.mode === 'automatic' || draft.automaticEnabled || activeExchanges.length > 0;
  const stopped = draft.emergencyStopped || status?.emergencyStopped === true;

  if (!authorized) return null;

  return <section className="rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm" data-testid="trade-automation-settings">
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="text-sm font-extrabold">승인 주문 · 자동매매</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">기본값은 모두 OFF이며 AI 채팅은 주문 권한이 없습니다.</p></div>
      <button type="button" onClick={() => void load()} aria-label="거래 설정 새로고침" className="rounded-xl border border-card-border p-2"><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /></button>
    </div>

    <div className="mt-4 rounded-2xl border border-primary/30 bg-primary/5 p-3" data-testid="optimization-safety-summary">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div><p className="text-xs font-black">수익 최적화 안전계약</p><p className="mt-1 text-[11px] text-muted-foreground">{PILOT_LABELS[draft.pilotStage]} · 일반 설정에서 단계 승격과 기준 완화 불가</p></div>
        </div>
        <span className={cn('rounded-full px-2 py-1 text-[10px] font-black', draft.riskOptimizationEnabled ? 'bg-positive/15 text-positive' : 'bg-destructive/15 text-destructive')}>
          {draft.riskOptimizationEnabled ? '강제 적용' : 'Live 차단'}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <SafetyMetric label="주식 1회 위험" value={`${draft.riskPerTradePercent.kiwoom}%`} />
        <SafetyMetric label="현물 1회 위험" value={`${draft.riskPerTradePercent.upbit}%`} />
        <SafetyMetric label="선물 1회 위험" value={`${draft.riskPerTradePercent.bitget}%`} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SafetyMetric label="비용 후 최소 EV" value={`+${draft.minExpectedValueR}R`} />
        <SafetyMetric label="최소 표본" value={`${draft.minStrategySampleSize}건`} />
        <SafetyMetric label="최소 PF" value={`${draft.minProfitFactor}`} />
        <SafetyMetric label="전체 일일정지" value={`-${draft.totalDailyLossLimitPercent}%`} />
        <SafetyMetric label="최대 낙폭" value={`${draft.maxStrategyDrawdownPercent}%`} />
        <SafetyMetric label="최대 슬리피지" value={`${draft.maxEstimatedSlippagePercent}%`} />
        <SafetyMetric label="평균 스프레드" value={`${draft.maxAverageSpreadPercent}%`} />
        <SafetyMetric label="상관 노출" value={`${draft.maxCorrelatedExposurePercent}%`} />
      </div>
      <p className="mt-3 flex items-center gap-1 text-[10px] font-bold text-muted-foreground"><LockKeyhole className="h-3 w-3" />첫 20건은 위험예산 50%, 승인형, 선물 1배·BTC/ETH만 허용합니다.</p>
    </div>

    {stopped && <div className="mt-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-3" data-testid="trading-stopped-banner">
      <p className="flex items-center gap-2 text-xs font-black text-destructive"><ShieldAlert className="h-4 w-4" />긴급정지 중 · 신규 주문 전면 차단</p>
      <p className="mt-1 text-[11px] text-muted-foreground">원인을 확인한 뒤 정지를 해제해도 자동매매와 거래소는 모두 OFF로 유지됩니다.</p>
      <button type="button" onClick={() => void resumeEvaluation()} className="mt-3 w-full rounded-xl border border-card-border bg-card px-3 py-2 text-xs font-extrabold">정지 해제 후 신호 재검사</button>
    </div>}

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
      <ModeButton active={draft.mode === 'approval'} onClick={() => setDraft((value) => ({ ...value, mode: 'approval', automaticEnabled: false, exchangeEnabled: { bitget: false, upbit: false, kiwoom: false } }))} label="승인형 주문" detail="승인 직전 조건 재검사" />
      <ModeButton active={draft.mode === 'automatic'} onClick={() => setDraft((value) => ({ ...value, mode: 'automatic', automaticEnabled: true }))} label="자동매매" detail="Paper 검증 · 실전은 단계 제한" />
    </div>

    <div className="mt-3 space-y-2">
      {(Object.keys(EXCHANGE_LABELS) as Exchange[]).map((exchange) => <button key={exchange} type="button" disabled={draft.mode !== 'automatic' || stopped} onClick={() => toggleExchange(exchange)} className="flex w-full items-center justify-between rounded-2xl border border-card-border bg-background p-3 disabled:opacity-50">
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
      <NumberField label="1회 주문금액 상한" value={draft.maxOrderKrw} onChange={(value) => updateNumber('maxOrderKrw', value)} suffix="원" />
      <NumberField label="최대 보유비중" value={draft.maxAssetPercent} onChange={(value) => updateNumber('maxAssetPercent', value)} suffix="%" />
      <NumberField label="기존 일일 손실한도" value={draft.dailyLossLimitPercent} onChange={(value) => updateNumber('dailyLossLimitPercent', value)} suffix="%" />
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

    <label className="mt-3 block rounded-2xl border border-card-border bg-background p-3 text-xs font-extrabold">Bitget 검증 후 최대 레버리지
      <select aria-label="Bitget 레버리지" value={draft.bitgetLeverage} onChange={(event) => setDraft((value) => ({ ...value, bitgetLeverage: Number(event.target.value) === 3 ? 3 : 2 }))} className="mt-2 h-11 w-full rounded-xl border border-card-border bg-card px-3">
        <option value="2">최대 2배</option><option value="3">최대 3배</option>
      </select>
      <span className="mt-1 block text-[10px] font-medium text-muted-foreground">첫 20건 실전 파일럿은 이 설정과 무관하게 1배로 고정됩니다.</span>
    </label>

    <div className="mt-3 rounded-2xl border border-card-border bg-background p-3 text-xs">
      <p className="font-extrabold">마지막 주문 · 체결 · 오류</p>
      <p className="mt-1 text-muted-foreground" data-testid="last-trade-state">{status?.lastOrder ? `${EXCHANGE_LABELS[status.lastOrder.exchange]} · ${status.lastOrder.state}${status.lastOrder.lastErrorCode ? ` · ${status.lastOrder.lastErrorCode}` : ''}` : '주문 기록 없음'}</p>
    </div>

    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <button type="button" disabled={stopped} onClick={() => needsConfirmation ? setConfirming(true) : void save(false)} className="rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground disabled:opacity-50">설정 저장</button>
      <button type="button" onClick={() => void emergencyStop()} className="flex items-center justify-center gap-2 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-extrabold text-destructive"><Power className="h-4 w-4" />긴급정지</button>
    </div>
    {message && <p role="status" className="mt-3 rounded-2xl bg-secondary p-3 text-xs font-bold">{message}</p>}

    {confirming && <div className="fixed inset-0 z-50 flex items-end bg-black/50 p-3 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="자동매매 최종 확인">
      <div className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-card p-5 shadow-2xl">
        <div className="flex items-center gap-2 text-destructive"><ShieldAlert className="h-6 w-6" /><h3 className="text-lg font-black">자동매매 최종 확인</h3></div>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="font-bold">파일럿 단계</dt><dd>{PILOT_LABELS[draft.pilotStage]}</dd>
          <dt className="font-bold">실제 자금</dt><dd>{activeExchanges.some((key) => connections[key]?.accountMode === 'live') ? '서버 승인·최종 위험 게이트 필요' : 'Paper·모의만'}</dd>
          <dt className="font-bold">실전 자동</dt><dd>{draft.pilotStage === 'validated' ? '성과기준 통과 전략만 가능' : '현재 단계에서는 차단'}</dd>
          <dt className="font-bold">활성 거래소</dt><dd>{activeExchanges.map((key) => EXCHANGE_LABELS[key]).join(', ') || '없음'}</dd>
          <dt className="font-bold">허용 자산</dt><dd>{activeExchanges.flatMap((key) => draft.enabledAssets[key].map((asset) => `${EXCHANGE_LABELS[key]}:${asset}`)).join(', ') || '없음'}</dd>
          <dt className="font-bold">최대 주문</dt><dd>{draft.maxOrderKrw.toLocaleString('ko-KR')}원 · 손절거리 위험수량이 더 작으면 자동 축소</dd>
          <dt className="font-bold">전체 일일정지</dt><dd>-{draft.totalDailyLossLimitPercent}% 도달 시 모든 신규진입 중지</dd>
          <dt className="font-bold">비용 후 EV</dt><dd>최소 +{draft.minExpectedValueR}R · 표본 {draft.minStrategySampleSize}건 이상</dd>
          <dt className="font-bold">레버리지</dt><dd>첫 20건 1배 · 검증 후 최대 {draft.bitgetLeverage}배</dd>
          <dt className="font-bold">허용 전략</dt><dd>{draft.enabledStrategies.join(', ') || '등록된 전략 없음'}</dd>
          <dt className="font-bold">긴급정지</dt><dd>정지 해제 후에도 자동매매·거래소 OFF</dd>
        </dl>
        <div className="mt-5 grid grid-cols-2 gap-2"><button type="button" onClick={() => setConfirming(false)} className="rounded-2xl border border-card-border px-4 py-3 font-extrabold">취소</button><button type="button" onClick={() => void save(true)} className="rounded-2xl bg-destructive px-4 py-3 font-extrabold text-white">위험 확인 및 저장</button></div>
      </div>
    </div>}
  </section>;
}

function SafetyMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-card-border bg-background px-2 py-2"><span className="block text-[9px] font-bold text-muted-foreground">{label}</span><strong className="mt-0.5 block text-xs">{value}</strong></div>;
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
