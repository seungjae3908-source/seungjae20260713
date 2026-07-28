import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, ShieldCheck, X } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useMemberPermissions } from '@/lib/permissions';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;
type Asset = 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';
type TriggerAction = 'BUY' | 'SELL' | 'CLOSE';

type LevelTrigger = {
  key: string;
  label: string;
  price: number;
  action: TriggerAction;
};

type ApprovalState = {
  trigger: LevelTrigger;
  status: 'PREPARING' | 'READY' | 'EXECUTING' | 'SUCCESS' | 'ERROR';
  approvalToken: string | null;
  executePath: string | null;
  order: AnyObj | null;
  message: string;
};

type TradeSettings = {
  enabled: boolean;
  stockAmount: string;
  futuresMargin: string;
  leverage: number;
};

const SETTINGS_KEY = 'chart-relay-real-order-settings.v1';
const KEY_SESSION = 'chart-relay-real-order-key.session.v1';
const COOLDOWN_MS = 30 * 60_000;

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function loadSettings(): TradeSettings {
  if (typeof window === 'undefined') {
    return { enabled: false, stockAmount: '', futuresMargin: '', leverage: 2 };
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<TradeSettings>;
    return {
      enabled: parsed.enabled === true,
      stockAmount: String(parsed.stockAmount ?? ''),
      futuresMargin: String(parsed.futuresMargin ?? ''),
      leverage: Math.max(1, Math.min(5, Math.round(Number(parsed.leverage ?? 2) || 2))),
    };
  } catch {
    return { enabled: false, stockAmount: '', futuresMargin: '', leverage: 2 };
  }
}

function saveSettings(settings: TradeSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function formatPrice(value: unknown, asset: Asset): string {
  const price = finite(value);
  if (price == null) return '가격 확인 불가';
  if (asset === 'stockUS') {
    return `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (asset === 'stockKR') return `${Math.round(price).toLocaleString()}원`;
  return `${price.toLocaleString(undefined, { maximumFractionDigits: price >= 100 ? 2 : 6 })} USDT`;
}

function percentDistance(from: unknown, to: unknown, fallback: number): number {
  const current = finite(from);
  const target = finite(to);
  if (current == null || target == null) return fallback;
  return Math.max(0.2, Math.min(50, Math.abs(((target - current) / current) * 100)));
}

function cooldownKey(symbol: string, interval: string, trigger: LevelTrigger): string {
  return `chart-relay-real-order-trigger:${symbol}:${interval}:${trigger.key}:${trigger.price}`;
}

function recentlyTriggered(symbol: string, interval: string, trigger: LevelTrigger): boolean {
  if (typeof window === 'undefined') return false;
  const timestamp = Number(window.localStorage.getItem(cooldownKey(symbol, interval, trigger)) ?? 0);
  return Number.isFinite(timestamp) && Date.now() - timestamp < COOLDOWN_MS;
}

function markTriggered(symbol: string, interval: string, trigger: LevelTrigger): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(cooldownKey(symbol, interval, trigger), String(Date.now()));
}

async function jsonRequest(path: string, key: string, body: AnyObj): Promise<AnyObj> {
  const response = await authorizedFetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auto-Trade-Key': key,
      'X-Crypto-Auto-Trade-Key': key,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload?.message ?? payload?.error ?? `HTTP_${response.status}`));
  }
  return payload;
}

export function ChartRelayAutoOrderApproval({
  plan,
  candles,
  asset,
  symbol,
  interval,
}: {
  plan: AnyObj | null;
  candles: AnyObj[];
  asset: Asset;
  symbol: string;
  interval: string;
}) {
  const permissions = useMemberPermissions();
  const [settings, setSettings] = useState<TradeSettings>(() => loadSettings());
  const [executionKey, setExecutionKey] = useState(() =>
    typeof window === 'undefined' ? '' : window.sessionStorage.getItem(KEY_SESSION) ?? '',
  );
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const previousPriceRef = useRef<number | null>(null);
  const busyRef = useRef(false);

  const currentPrice = finite(candles.at(-1)?.close ?? plan?.currentPrice);

  const triggers = useMemo<LevelTrigger[]>(() => {
    if (!plan) return [];
    const rows: Array<LevelTrigger | null> = [
      ...[0, 1, 2].map((index) => {
        const price = finite(plan.buyLevels?.[index]);
        return price == null
          ? null
          : {
              key: `buy-${index + 1}`,
              label: `${index + 1}차 매수가`,
              price,
              action: 'BUY' as const,
            };
      }),
      ...[0, 1, 2].map((index) => {
        const price = finite(plan.sellLevels?.[index]);
        return price == null
          ? null
          : {
              key: `sell-${index + 1}`,
              label: `${index + 1}차 매도가`,
              price,
              action: 'SELL' as const,
            };
      }),
      finite(plan.target) == null
        ? null
        : { key: 'target', label: '목표가', price: finite(plan.target)!, action: 'CLOSE' },
      finite(plan.stop) == null
        ? null
        : { key: 'stop', label: '손절가', price: finite(plan.stop)!, action: 'CLOSE' },
    ];
    return rows.filter((item): item is LevelTrigger => item != null);
  }, [plan]);

  const updateSettings = (patch: Partial<TradeSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveSettings(next);
      return next;
    });
  };

  const updateExecutionKey = (value: string) => {
    setExecutionKey(value);
    if (typeof window !== 'undefined') {
      if (value.trim()) window.sessionStorage.setItem(KEY_SESSION, value.trim());
      else window.sessionStorage.removeItem(KEY_SESSION);
    }
  };

  const prepareApproval = async (trigger: LevelTrigger) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setApproval({
      trigger,
      status: 'PREPARING',
      approvalToken: null,
      executePath: null,
      order: null,
      message: '최신 가격과 계좌 안전조건으로 실제 주문계획을 확인하고 있습니다.',
    });

    try {
      const key = executionKey.trim();
      if (!key) throw new Error('설정에서 자동매매 실행키를 먼저 입력하세요.');
      if (asset === 'coinSpot') {
        throw new Error('코인 현물 실제 주문은 아직 연결되지 않았습니다. 국내·해외주식 또는 코인 선물을 선택하세요.');
      }

      let response: AnyObj;
      let executePath: string;

      if (asset === 'stockKR' || asset === 'stockUS') {
        const market = asset === 'stockUS' ? 'US' : 'KR';
        if (trigger.action === 'BUY') {
          const amount = finite(settings.stockAmount);
          if (amount == null) throw new Error('실제 주문 1회 금액을 입력하세요.');
          response = await jsonRequest('/api/stocks/auto-trade/plan', key, {
            candidates: [
              {
                ticker: symbol,
                name: symbol,
                market,
                probability: 100,
                score: 100,
                reason: `${trigger.label} 도달`,
              },
            ],
            investmentPerTrade: amount,
            stopLossPercent: percentDistance(currentPrice, plan?.stop, 3),
            takeProfitPercent: percentDistance(currentPrice, plan?.target, 5),
          });
          executePath = '/api/stocks/auto-trade/execute';
        } else {
          response = await jsonRequest('/api/stocks/auto-trade/close-plan', key, {
            ticker: symbol,
            market,
            reason: `${trigger.label} 도달`,
          });
          executePath = '/api/stocks/auto-trade/close-execute';
        }
      } else {
        if (trigger.action === 'CLOSE') {
          response = await jsonRequest('/api/crypto/futures/auto/close-plan', key, {
            symbol,
            holdSide: plan?.view === '매도' ? 'short' : 'long',
            reason: `${trigger.label} 도달`,
          });
          executePath = '/api/crypto/futures/auto/close';
        } else {
          const margin = finite(settings.futuresMargin);
          if (margin == null) throw new Error('코인 선물 1회 증거금(USDT)을 입력하세요.');
          const direction = trigger.action === 'BUY' ? 'LONG' : 'SHORT';
          const aligned =
            (direction === 'LONG' && plan?.view === '매수') ||
            (direction === 'SHORT' && plan?.view === '매도');
          response = await jsonRequest('/api/crypto/futures/auto/plan', key, {
            symbol,
            direction,
            executionMode: 'REAL',
            positionMode: 'one_way_mode',
            marginMode: 'isolated',
            leverage: settings.leverage,
            marginAmountUSDT: margin,
            score: aligned ? 90 : 80,
            oppositeScore: aligned ? 10 : 20,
            minScore: 70,
            stopLossPercent: percentDistance(currentPrice, plan?.stop, 1.5),
            targetProfitPercent: percentDistance(currentPrice, plan?.target, 3),
            maxOpenPositions: 3,
            maxDailyOrders: 5,
            reasons: [`${trigger.label} 도달`, ...(Array.isArray(plan?.basis) ? plan.basis.slice(0, 5) : [])],
          });
          executePath = '/api/crypto/futures/auto/execute';
        }
      }

      const token = String(response?.approvalToken ?? '').trim();
      if (!token) throw new Error('서버가 일회성 주문 승인번호를 반환하지 않았습니다.');

      setApproval({
        trigger,
        status: 'READY',
        approvalToken: token,
        executePath,
        order: response?.order ?? response?.plan ?? null,
        message: String(response?.warning ?? response?.message ?? '주문 내용을 확인한 뒤 실행하세요.'),
      });
    } catch (error) {
      setApproval({
        trigger,
        status: 'ERROR',
        approvalToken: null,
        executePath: null,
        order: null,
        message: error instanceof Error ? error.message : '주문계획 생성에 실패했습니다.',
      });
    } finally {
      busyRef.current = false;
    }
  };

  const executeApproval = async () => {
    if (!approval?.approvalToken || !approval.executePath || approval.status !== 'READY') return;
    setApproval((current) =>
      current ? { ...current, status: 'EXECUTING', message: '실제 주문을 전송하고 체결 결과를 확인하고 있습니다.' } : current,
    );
    try {
      const result = await jsonRequest(approval.executePath, executionKey.trim(), {
        approvalToken: approval.approvalToken,
      });
      setApproval((current) =>
        current
          ? {
              ...current,
              status: 'SUCCESS',
              message: String(result?.message ?? result?.journal?.message ?? '실제 주문 요청이 처리됐습니다. 거래소 주문·체결내역을 확인하세요.'),
            }
          : current,
      );
    } catch (error) {
      setApproval((current) =>
        current
          ? {
              ...current,
              status: 'ERROR',
              message: error instanceof Error ? error.message : '실제 주문 실행에 실패했습니다.',
            }
          : current,
      );
    }
  };

  useEffect(() => {
    if (!permissions.has('autoTrading') || !settings.enabled || currentPrice == null || triggers.length === 0) {
      previousPriceRef.current = currentPrice;
      return;
    }
    const previous = previousPriceRef.current;
    previousPriceRef.current = currentPrice;
    if (previous == null || approval) return;

    for (const trigger of triggers) {
      if (recentlyTriggered(symbol, interval, trigger)) continue;
      const tolerance = Math.max(trigger.price * 0.0008, Math.abs(currentPrice - previous) * 0.25);
      const near = Math.abs(currentPrice - trigger.price) <= tolerance;
      const crossedDown = previous > trigger.price && currentPrice <= trigger.price;
      const crossedUp = previous < trigger.price && currentPrice >= trigger.price;
      const reached =
        trigger.action === 'BUY'
          ? near || crossedDown
          : trigger.action === 'SELL'
            ? near || crossedUp
            : near || crossedDown || crossedUp;
      if (!reached) continue;
      markTriggered(symbol, interval, trigger);
      void prepareApproval(trigger);
      break;
    }
  }, [approval, currentPrice, interval, permissions, settings.enabled, symbol, triggers]);

  if (!permissions.has('autoTrading')) return null;

  return (
    <>
      <section className="mt-3 rounded-3xl border border-destructive/35 bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-black">관리자 실제 주문 감시</h2>
            <p className="mt-1 text-[10px] font-bold leading-4 text-muted-foreground">
              1·2·3차 매수가·매도가·목표가·손절가 도달을 감지해 일회성 주문계획을 만들고, 실제 주문은 반드시 실행 버튼을 눌러야 전송됩니다.
            </p>
          </div>
          <ShieldCheck className="h-5 w-5 shrink-0 text-destructive" />
        </div>

        <button
          type="button"
          onClick={() => updateSettings({ enabled: !settings.enabled })}
          className={cn(
            'mt-3 h-11 w-full rounded-2xl border text-sm font-black',
            settings.enabled
              ? 'border-destructive bg-destructive/10 text-destructive'
              : 'border-card-border bg-background text-muted-foreground',
          )}
        >
          {settings.enabled ? '실제 주문 감시 켜짐' : '실제 주문 감시 꺼짐'}
        </button>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {(asset === 'stockKR' || asset === 'stockUS') && (
            <label className="col-span-2 text-[10px] font-black text-muted-foreground">
              1회 주문금액 ({asset === 'stockUS' ? 'USD' : 'KRW'})
              <input
                type="number"
                inputMode="decimal"
                value={settings.stockAmount}
                onChange={(event) => updateSettings({ stockAmount: event.target.value })}
                placeholder="직접 입력"
                className="mt-1 h-10 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-black outline-none focus:border-primary"
              />
            </label>
          )}
          {asset === 'coinFutures' && (
            <>
              <label className="text-[10px] font-black text-muted-foreground">
                1회 증거금 USDT
                <input
                  type="number"
                  inputMode="decimal"
                  value={settings.futuresMargin}
                  onChange={(event) => updateSettings({ futuresMargin: event.target.value })}
                  placeholder="직접 입력"
                  className="mt-1 h-10 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-black outline-none focus:border-primary"
                />
              </label>
              <label className="text-[10px] font-black text-muted-foreground">
                레버리지
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={settings.leverage}
                  onChange={(event) => updateSettings({ leverage: Math.max(1, Math.min(5, Number(event.target.value) || 1)) })}
                  className="mt-1 h-10 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-black outline-none focus:border-primary"
                />
              </label>
            </>
          )}
          <label className="col-span-2 text-[10px] font-black text-muted-foreground">
            자동매매 실행키 · 현재 브라우저 탭에만 보관
            <div className="relative mt-1">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="password"
                value={executionKey}
                onChange={(event) => updateExecutionKey(event.target.value)}
                placeholder="Replit Secrets의 실행키와 동일하게 입력"
                className="h-10 w-full rounded-xl border border-card-border bg-background pl-10 pr-3 text-sm font-black outline-none focus:border-primary"
              />
            </div>
          </label>
        </div>

        {asset === 'coinSpot' && (
          <p className="mt-3 rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2 text-center text-[10px] font-black text-warning">
            코인 현물 실제 주문은 아직 연결되지 않았습니다.
          </p>
        )}
      </section>

      {approval && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/75 p-4" onClick={() => approval.status !== 'EXECUTING' && setApproval(null)}>
          <section
            role="dialog"
            aria-modal="true"
            className="relative max-h-[88vh] w-full max-w-md overflow-y-auto rounded-3xl border border-destructive/50 bg-background p-5 text-center shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              disabled={approval.status === 'EXECUTING'}
              onClick={() => setApproval(null)}
              aria-label="닫기"
              className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card disabled:opacity-40"
            >
              <X className="h-4 w-4" />
            </button>

            <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
            <p className="mt-2 text-[10px] font-black text-destructive">실제 주문 확인</p>
            <h3 className="mt-1 text-lg font-black">{symbol} · {approval.trigger.label} 도달</h3>
            <p className="mt-1 text-sm font-black">기준 {formatPrice(approval.trigger.price, asset)}</p>
            <p className="mt-1 text-xs font-bold text-muted-foreground">현재 {formatPrice(currentPrice, asset)}</p>

            <div className="mt-4 rounded-2xl bg-secondary px-4 py-3 text-xs font-bold leading-5">
              {approval.message}
            </div>

            {approval.order && (
              <div className="mt-3 rounded-2xl border border-card-border bg-card p-3 text-left text-[10px] font-bold leading-5">
                <p>방향: {String(approval.order.direction ?? approval.order.side ?? approval.trigger.action)}</p>
                <p>수량: {String(approval.order.quantity ?? approval.order.size ?? approval.order.positionSize ?? '서버 계산')}</p>
                <p>현재가: {formatPrice(approval.order.currentPrice ?? approval.order.markPrice ?? currentPrice, asset)}</p>
                <p>목표가: {formatPrice(approval.order.targetPrice ?? plan?.target, asset)}</p>
                <p>손절가: {formatPrice(approval.order.stopPrice ?? plan?.stop, asset)}</p>
              </div>
            )}

            {approval.status === 'READY' && (
              <button
                type="button"
                onClick={() => void executeApproval()}
                className="mt-4 h-12 w-full rounded-2xl bg-destructive text-sm font-black text-destructive-foreground"
              >
                실제 주문 실행
              </button>
            )}
            {(approval.status === 'PREPARING' || approval.status === 'EXECUTING') && (
              <div className="mt-4 flex h-12 items-center justify-center gap-2 rounded-2xl bg-secondary text-sm font-black text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {approval.status === 'PREPARING' ? '주문계획 확인 중' : '실제 주문 처리 중'}
              </div>
            )}
            {approval.status === 'SUCCESS' && (
              <button
                type="button"
                onClick={() => setApproval(null)}
                className="mt-4 h-12 w-full rounded-2xl bg-positive text-sm font-black text-white"
              >
                주문 결과 확인 완료
              </button>
            )}
            {approval.status === 'ERROR' && (
              <button
                type="button"
                onClick={() => setApproval(null)}
                className="mt-4 h-12 w-full rounded-2xl border border-card-border bg-card text-sm font-black"
              >
                닫기
              </button>
            )}
          </section>
        </div>
      )}
    </>
  );
}
