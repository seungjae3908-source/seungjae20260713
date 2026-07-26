import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bell,
  BellRing,
  ChevronRight,
  CircleAlert,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { isInWatchlist } from '@/lib/stock-display';
import { addChartRelayMessage } from '@/lib/chart-relay-message-store';

type AnyObj = Record<string, any>;
type Asset = 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';

type PriceLevel = {
  key: string;
  label: string;
  price: number;
  tone: string;
  direction: 'up' | 'down' | 'either';
};

type ReachedAlert = PriceLevel & {
  id: string;
  currentPrice: number;
  reachedAt: number;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPrice(value: number | null | undefined, asset: Asset): string {
  if (value == null || !Number.isFinite(value)) return '산출 불가';
  if (asset === 'stockUS') {
    return `$${value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (asset === 'coinSpot' || asset === 'coinFutures') {
    return value.toLocaleString(undefined, {
      maximumFractionDigits: value >= 100 ? 0 : 4,
    });
  }
  return `${Math.round(value).toLocaleString()}원`;
}

function formatTime(value: unknown): string {
  const date = new Date(String(value ?? ''));
  if (!Number.isFinite(date.getTime())) return '시간 정보 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function stageLabel(stage: string): string {
  if (stage === 'COMPLETED') return '완성';
  if (stage === 'DEVELOPING') return '진행';
  if (stage === 'INVALIDATED') return '이탈';
  return '시작';
}

function importanceLabel(value: unknown): '높음' | '중간' | '낮음' {
  const text = String(value ?? '').toLowerCase();
  if (text.includes('high') || text.includes('높') || text.includes('critical')) return '높음';
  if (text.includes('low') || text.includes('낮')) return '낮음';
  return '중간';
}

function kindLabel(kind: string): string {
  if (kind === 'candle') return '캔들 패턴';
  if (kind === 'volume') return '거래량 신호';
  if (kind === 'indicator') return '기술지표';
  return '차트 패턴';
}

function isBullish(signal: AnyObj): boolean {
  return /상승|매수|강세|돌파|쌍바닥|망치|샛별/.test(String(signal?.name ?? ''));
}

function isBearish(signal: AnyObj): boolean {
  return /하락|매도|약세|이탈|쌍봉|유성|석별/.test(String(signal?.name ?? ''));
}

function signalWeight(signal: AnyObj): number {
  const importance = importanceLabel(signal.importance);
  const stage = String(signal.stage ?? 'START');
  const importanceWeight = importance === '높음' ? 4 : importance === '중간' ? 2 : 1;
  const stageWeight = stage === 'COMPLETED' ? 3 : stage === 'DEVELOPING' ? 2 : stage === 'INVALIDATED' ? -2 : 1;
  return Math.max(0, importanceWeight + stageWeight);
}

function alertStorageKey(symbol: string, interval: string, level: PriceLevel): string {
  return `chart-relay-price-alert:${symbol}:${interval}:${level.key}:${level.price}`;
}

function readLastAlert(symbol: string, interval: string, level: PriceLevel): number {
  if (typeof window === 'undefined') return 0;
  const raw = window.localStorage.getItem(alertStorageKey(symbol, interval, level));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function writeLastAlert(symbol: string, interval: string, level: PriceLevel, value: number): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(alertStorageKey(symbol, interval, level), String(value));
}

export function PriceLevelAlertMonitor({
  plan,
  candles,
  asset,
  symbol,
  interval,
  settings,
}: {
  plan: AnyObj | null;
  candles: AnyObj[];
  asset: Asset;
  symbol: string;
  interval: string;
  settings: AnyObj;
}) {
  const previousPriceRef = useRef<number | null>(null);
  const [alerts, setAlerts] = useState<ReachedAlert[]>([]);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return window.Notification.permission;
  });

  const currentPrice = finite(candles.at(-1)?.close ?? plan?.currentPrice);
  const volatility = Math.max(
    finite(plan?.volatility) ?? 0,
    currentPrice == null ? 0 : currentPrice * 0.001,
  );

  const levels = useMemo<PriceLevel[]>(() => {
    if (!plan || settings.levelAlerts === false) return [];
    const rows: Array<PriceLevel | null> = [
      settings.targetAlert === false || settings.target === false || finite(plan.target) == null
        ? null
        : {
            key: 'target',
            label: '목표가 도달',
            price: finite(plan.target)!,
            tone: 'text-orange-500',
            direction: 'up',
          },
      ...[0, 1, 2].map((index) => {
        const price = finite(plan.buyLevels?.[index]);
        if (
          settings.buyAlert === false ||
          settings.buyLevels === false ||
          settings[`buyLevel${index + 1}`] === false ||
          price == null
        ) {
          return null;
        }
        return {
          key: `buy-${index + 1}`,
          label: `${index + 1}차 분할매수 도달`,
          price,
          tone: 'text-red-500',
          direction: 'down' as const,
        };
      }),
      ...[0, 1, 2].map((index) => {
        const price = finite(plan.sellLevels?.[index]);
        if (
          settings.sellAlert === false ||
          settings.sellLevels === false ||
          settings[`sellLevel${index + 1}`] === false ||
          price == null
        ) {
          return null;
        }
        return {
          key: `sell-${index + 1}`,
          label: `${index + 1}차 분할매도 도달`,
          price,
          tone: 'text-blue-500',
          direction: 'up' as const,
        };
      }),
      settings.stopAlert === false || settings.stop === false || finite(plan.stop) == null
        ? null
        : {
            key: 'stop',
            label: '손절가 도달',
            price: finite(plan.stop)!,
            tone: 'text-cyan-500',
            direction: 'down',
          },
    ];
    return rows.filter((row): row is PriceLevel => row != null);
  }, [plan, settings]);

  useEffect(() => {
    if (currentPrice == null || levels.length === 0) {
      previousPriceRef.current = currentPrice;
      return;
    }

    const previousPrice = previousPriceRef.current;
    previousPriceRef.current = currentPrice;
    if (previousPrice == null) return;

    const now = Date.now();
    const cooldownMs = 30 * 60 * 1000;

    for (const level of levels) {
      const tolerance = Math.max(Math.abs(level.price) * 0.0008, volatility * 0.08, 0.0001);
      const near = Math.abs(currentPrice - level.price) <= tolerance;
      const crossedUp = previousPrice < level.price && currentPrice >= level.price;
      const crossedDown = previousPrice > level.price && currentPrice <= level.price;
      const reached =
        near ||
        (level.direction === 'up' && crossedUp) ||
        (level.direction === 'down' && crossedDown) ||
        (level.direction === 'either' && (crossedUp || crossedDown));

      if (!reached) continue;
      const lastAlert = readLastAlert(symbol, interval, level);
      if (now - lastAlert < cooldownMs) continue;
      writeLastAlert(symbol, interval, level, now);
      if (!isInWatchlist(symbol, asset)) continue;

      addChartRelayMessage({
        id: `price:${asset}:${symbol}:${interval}:${level.key}:${level.price}:${now}`,
        kind: 'price',
        symbol,
        asset,
        title: level.label,
        summary: `기준 ${formatPrice(level.price, asset)} · 현재 ${formatPrice(currentPrice, asset)}`,
        price: level.price,
        occurredAt: new Date(now).toISOString(),
      });

      const nextAlert: ReachedAlert = {
        ...level,
        id: `${level.key}:${level.price}:${now}`,
        currentPrice,
        reachedAt: now,
      };
      setAlerts((current) => [nextAlert, ...current].slice(0, 3));

      if (permission === 'granted' && typeof window !== 'undefined') {
        const notification = new window.Notification(`${symbol} · ${level.label}`, {
          body: `기준 ${formatPrice(level.price, asset)} · 현재 ${formatPrice(currentPrice, asset)}`,
          tag: `${symbol}:${interval}:${level.key}`,
        });
        window.setTimeout(() => notification.close(), 10_000);
      }
    }
  }, [asset, currentPrice, interval, levels, permission, symbol, volatility]);

  useEffect(() => {
    if (alerts.length === 0) return;
    const timer = window.setTimeout(() => {
      setAlerts((current) => current.slice(0, -1));
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [alerts]);

  const requestPermission = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setPermission('unsupported');
      return;
    }
    const next = await window.Notification.requestPermission();
    setPermission(next);
  };

  return (
    <>
      <section className="mt-3 rounded-2xl border border-card-border bg-card p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-black">목표가·손절가 도달 알림</h2>
          </div>
          <BellRing className="h-5 w-5 shrink-0 text-primary" />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-secondary p-3">
          <div>
            <p className="text-[10px] font-black">현재 감시 중 {levels.length}개</p>
            <p className="mt-0.5 text-[9px] font-bold text-muted-foreground">
              환경설정에서 전체·목표가·손절가·매수·매도 알림을 각각 끌 수 있습니다.
            </p>
          </div>
          {permission === 'default' ? (
            <button
              type="button"
              onClick={() => void requestPermission()}
              className="shrink-0 rounded-xl bg-primary px-3 py-2 text-[10px] font-black text-primary-foreground"
            >
              기기 알림 허용
            </button>
          ) : (
            <span className="shrink-0 rounded-full border border-card-border bg-background px-2 py-1 text-[9px] font-black text-muted-foreground">
              {permission === 'granted'
                ? '기기 알림 허용됨'
                : permission === 'denied'
                  ? '기기 알림 차단됨'
                  : '앱 내부 알림만'}
            </span>
          )}
        </div>
      </section>

      {false && alerts.length > 0 && (
        <div className="fixed left-1/2 top-[max(14px,env(safe-area-inset-top))] z-[130] w-[calc(100%-28px)] max-w-md -translate-x-1/2 space-y-2">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className="relative rounded-2xl border border-primary/50 bg-background p-4 pr-12 shadow-2xl"
            >
              <button
                type="button"
                aria-label="알림 닫기"
                onClick={() => setAlerts((current) => current.filter((item) => item.id !== alert.id))}
                className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full border border-card-border bg-card"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="flex items-start gap-3">
                <Bell className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <p className="text-sm font-black">{symbol} · {alert.label}</p>
                  <p className={cn('mt-1 text-base font-black', alert.tone)}>
                    {formatPrice(alert.price, asset)}
                  </p>
                  <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                    현재가 {formatPrice(alert.currentPrice, asset)} · {formatTime(alert.reachedAt)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function DetailedSignalAnalysisWorkspace({
  query,
  signals,
  activeSignalId,
  onSelect,
  plan,
  symbol,
  interval,
}: {
  query: AnyObj;
  signals: AnyObj[];
  activeSignalId: string | null;
  onSelect: (signal: AnyObj) => void;
  plan: AnyObj | null;
  asset: Asset;
  symbol: string;
  interval: string;
}) {
  const [kind, setKind] = useState('all');
  const [importance, setImportance] = useState('all');

  const uniqueSignals = useMemo(() => {
    const grouped = new Map<string, AnyObj>();
    for (const signal of signals) {
      const key = `${signal.kind}:${String(signal.name ?? '').trim().toLowerCase()}`;
      const current = grouped.get(key);
      const nextTime = new Date(String(signal.occurredAt ?? '')).getTime() || 0;
      const currentTime = current
        ? new Date(String(current.occurredAt ?? '')).getTime() || 0
        : -1;
      if (!current || nextTime >= currentTime) grouped.set(key, signal);
    }
    return [...grouped.values()].sort(
      (left, right) =>
        (new Date(String(right.occurredAt ?? '')).getTime() || 0) -
        (new Date(String(left.occurredAt ?? '')).getTime() || 0),
    );
  }, [signals]);

  const weightedBullish = uniqueSignals
    .filter(isBullish)
    .reduce((sum, signal) => sum + signalWeight(signal), 0);
  const weightedBearish = uniqueSignals
    .filter(isBearish)
    .reduce((sum, signal) => sum + signalWeight(signal), 0);
  const planBias = plan?.view === '매수' ? 5 : plan?.view === '매도' ? -5 : 0;
  const directionScore = weightedBullish - weightedBearish + planBias;
  const totalWeight = Math.max(weightedBullish + weightedBearish + Math.abs(planBias), 1);
  const confidence = Math.min(95, Math.max(35, Math.round(50 + (Math.abs(directionScore) / totalWeight) * 45)));
  const direction =
    directionScore >= 3
      ? { label: '상승 우세 예상', icon: TrendingUp, tone: 'text-red-500', side: '상승' }
      : directionScore <= -3
        ? { label: '하락 우세 예상', icon: TrendingDown, tone: 'text-blue-500', side: '하락' }
        : { label: '방향 혼조·관찰', icon: Activity, tone: 'text-foreground', side: '중립' };
  const DirectionIcon = direction.icon;

  const importantSignals = uniqueSignals
    .filter((signal) => {
      const importanceValue = importanceLabel(signal.importance);
      return (
        importanceValue === '높음' ||
        signal.stage === 'COMPLETED' ||
        signal.stage === 'INVALIDATED' ||
        signalWeight(signal) >= 5
      );
    })
    .sort((left, right) => signalWeight(right) - signalWeight(left))
    .slice(0, 5);

  const visibleSignals = uniqueSignals.filter((signal) => {
    if (kind !== 'all' && signal.kind !== kind) return false;
    if (importance !== 'all' && importanceLabel(signal.importance) !== importance) return false;
    return true;
  });

  const directionReasons = [
    plan?.view ? `가격 계획의 현재 판단은 ${plan.view}입니다.` : '가격 계획 방향 데이터가 아직 없습니다.',
    `가중 상승 신호 ${weightedBullish}점, 가중 하락 신호 ${weightedBearish}점으로 계산했습니다.`,
    direction.side === '상승'
      ? '중요 상승 신호가 하락 신호보다 강해 목표가 방향을 우선 관찰합니다.'
      : direction.side === '하락'
        ? '중요 하락 신호가 상승 신호보다 강해 손절가·지지선 이탈을 우선 관찰합니다.'
        : '상승과 하락 신호가 충돌해 다음 봉과 거래량 확인 전까지 추격 진입을 피하는 구간입니다.',
    ...(Array.isArray(plan?.basis) ? plan.basis.slice(0, 3).map(String) : []),
  ];

  const importantReason = (signal: AnyObj): string[] => {
    const reasons: string[] = [];
    if (importanceLabel(signal.importance) === '높음') reasons.push('분석 엔진에서 중요도 높음으로 분류됐습니다.');
    if (signal.stage === 'COMPLETED') reasons.push('패턴 또는 조건이 완성 단계까지 확인됐습니다.');
    if (signal.stage === 'INVALIDATED') reasons.push('기존 방향을 무효화하는 이탈 신호이므로 위험관리 우선 신호입니다.');
    if (direction.side === '상승' && isBullish(signal)) reasons.push('현재 예상 상승 방향과 일치합니다.');
    if (direction.side === '하락' && isBearish(signal)) reasons.push('현재 예상 하락 방향과 일치합니다.');
    if (Array.isArray(signal.confirmations) && signal.confirmations.length > 0) {
      reasons.push(`확인 조건 ${signal.confirmations.length}개가 함께 제공된 신호입니다.`);
    }
    return reasons.length > 0 ? reasons : ['현재 신호 중 상대적으로 영향도가 높은 신호입니다.'];
  };

  return (
    <section className="mt-3 space-y-3">
      <div className="rounded-3xl border border-card-border bg-card p-4">
        <p className="text-[10px] font-black text-primary">실시간 예상 방향</p>
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <DirectionIcon className={cn('h-6 w-6', direction.tone)} />
            <h2 className={cn('text-xl font-black', direction.tone)}>{direction.label}</h2>
          </div>
          <span className="rounded-full bg-primary/10 px-3 py-1 text-[10px] font-black text-primary">
            신뢰도 {confidence}%
          </span>
        </div>
        <p className="mt-2 text-[11px] font-bold leading-5 text-muted-foreground">
          {symbol} · {interval}에서 현재 신호의 방향과 중요도, 완성 단계, 가격 계획을 합쳐 예상 방향을 계산했습니다.
        </p>

        <div className="mt-3 space-y-2">
          {directionReasons.map((reason, index) => (
            <div key={`${index}:${reason}`} className="rounded-2xl bg-secondary px-3 py-2.5 text-[10px] font-bold leading-4">
              {index + 1}. {reason}
            </div>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-2xl border border-card-border bg-background p-3 text-center">
            <TrendingUp className="mx-auto h-4 w-4 text-red-500" />
            <p className="mt-1 text-lg font-black">{weightedBullish}</p>
            <p className="text-[9px] font-bold text-muted-foreground">상승 가중점수</p>
          </div>
          <div className="rounded-2xl border border-card-border bg-background p-3 text-center">
            <TrendingDown className="mx-auto h-4 w-4 text-blue-500" />
            <p className="mt-1 text-lg font-black">{weightedBearish}</p>
            <p className="text-[9px] font-bold text-muted-foreground">하락 가중점수</p>
          </div>
          <div className="rounded-2xl border border-card-border bg-background p-3 text-center">
            <Sparkles className="mx-auto h-4 w-4 text-primary" />
            <p className="mt-1 text-lg font-black">{importantSignals.length}</p>
            <p className="text-[9px] font-bold text-muted-foreground">중요 신호</p>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border-2 border-primary/50 bg-primary/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <CircleAlert className="h-5 w-5 text-primary" />
              <h3 className="text-base font-black">중요 신호</h3>
            </div>
            <p className="mt-1 text-[10px] font-bold text-muted-foreground">
              중요도·완성 단계·현재 예상 방향과의 일치 여부가 높은 신호를 먼저 강조합니다.
            </p>
          </div>
          <span className="rounded-full bg-primary px-2 py-1 text-[9px] font-black text-primary-foreground">
            우선 확인
          </span>
        </div>

        <div className="mt-3 space-y-3">
          {importantSignals.length === 0 ? (
            <div className="rounded-2xl bg-background px-3 py-5 text-center text-[11px] font-bold text-muted-foreground">
              현재 별도로 강조할 중요 신호가 없습니다.
            </div>
          ) : (
            importantSignals.map((signal) => (
              <button
                key={`important:${signal.kind}:${signal.id}`}
                type="button"
                onClick={() => onSelect(signal)}
                className="w-full rounded-2xl border border-primary/50 bg-background p-3 text-left shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-black text-primary-foreground">중요</span>
                      <p className="truncate text-sm font-black">{String(signal.name ?? '신호')}</p>
                      <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-black text-muted-foreground">
                        {stageLabel(String(signal.stage ?? 'START'))}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                      {kindLabel(String(signal.kind ?? 'chart'))} · 중요도 {importanceLabel(signal.importance)} · {formatTime(signal.occurredAt)}
                    </p>
                    <p className="mt-2 text-[10px] font-black">왜 중요한가</p>
                    {importantReason(signal).map((reason, index) => (
                      <p key={`${index}:${reason}`} className="mt-1 text-[10px] font-bold leading-4 text-foreground">
                        · {reason}
                      </p>
                    ))}
                    {signal.meaningHere && (
                      <p className="mt-2 rounded-xl bg-secondary px-2.5 py-2 text-[10px] font-bold leading-4">
                        {String(signal.meaningHere)}
                      </p>
                    )}
                  </div>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-primary" />
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-card-border bg-card p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-black">전체 실시간 신호</h3>
            <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
              중요 신호 아래에 나머지 신호를 시간순으로 표시합니다. 누르면 상세 근거가 중앙에 열립니다.
            </p>
          </div>
          <Activity className="h-5 w-5 shrink-0 text-primary" />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="rounded-xl border border-card-border bg-background px-2 py-2 text-[10px] font-black"
            aria-label="신호 종류"
          >
            <option value="all">종류 전체</option>
            <option value="chart">차트 패턴</option>
            <option value="candle">캔들 패턴</option>
            <option value="volume">거래량</option>
            <option value="indicator">기술지표</option>
          </select>
          <select
            value={importance}
            onChange={(event) => setImportance(event.target.value)}
            className="rounded-xl border border-card-border bg-background px-2 py-2 text-[10px] font-black"
            aria-label="신호 중요도"
          >
            <option value="all">중요도 전체</option>
            <option value="높음">높음</option>
            <option value="중간">중간</option>
            <option value="낮음">낮음</option>
          </select>
        </div>

        <div className="mt-3 space-y-2">
          {query?.isLoading && uniqueSignals.length === 0 ? (
            <div className="rounded-2xl bg-secondary px-3 py-5 text-center text-[11px] font-bold text-muted-foreground">신호 분석 중...</div>
          ) : query?.isError && uniqueSignals.length === 0 ? (
            <div className="rounded-2xl border border-warning/40 bg-warning/10 px-3 py-5 text-center text-[11px] font-bold text-warning">신호 데이터를 불러오지 못했습니다.</div>
          ) : visibleSignals.length === 0 ? (
            <div className="rounded-2xl bg-secondary px-3 py-5 text-center text-[11px] font-bold text-muted-foreground">선택한 조건에 맞는 신호가 없습니다.</div>
          ) : (
            visibleSignals.map((signal) => {
              const highlighted = importantSignals.some((item) => item.id === signal.id);
              return (
                <button
                  key={`${signal.kind}:${signal.id}`}
                  type="button"
                  onClick={() => onSelect(signal)}
                  className={cn(
                    'w-full rounded-2xl border p-3 text-left',
                    activeSignalId === signal.id
                      ? 'border-primary bg-primary/5'
                      : highlighted
                        ? 'border-primary/50 bg-primary/5'
                        : 'border-card-border bg-background',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1">
                        {highlighted && (
                          <span className="rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-black text-primary-foreground">중요</span>
                        )}
                        <p className="truncate text-sm font-black">{String(signal.name ?? '신호')}</p>
                        <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-black text-muted-foreground">
                          {stageLabel(String(signal.stage ?? 'START'))}
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                        {kindLabel(String(signal.kind ?? 'chart'))} · 중요도 {importanceLabel(signal.importance)} · {formatTime(signal.occurredAt)}
                      </p>
                      <p className="mt-2 line-clamp-2 text-[10px] font-bold leading-4 text-foreground">
                        {String(signal.meaningHere || signal.meaningGeneral || '현재 조건과 과거 패턴의 관계를 분석한 신호입니다.')}
                      </p>
                    </div>
                    <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-primary" />
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="flex gap-2 rounded-2xl border border-warning/40 bg-warning/10 p-3 text-[10px] font-bold leading-4 text-warning">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>예상 방향과 신호는 참고용이며 실제 주문을 실행하지 않습니다. 중요 신호라도 무효화 조건과 손절가를 함께 확인해야 합니다.</span>
      </div>
    </section>
  );
}
