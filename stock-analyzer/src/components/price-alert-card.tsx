import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, ChevronDown, Pencil, Trash2 } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

type AlertCondition =
  | 'price_above'
  | 'price_below'
  | 'change_above'
  | 'change_below';

type PriceAlertRow = {
  id: string;
  asset_type: string;
  market: string;
  symbol: string;
  condition_type?: AlertCondition;
  target_value?: number | string;
  direction?: 'above' | 'below';
  target_price?: number | string;
  repeat_enabled?: boolean;
  app_enabled?: boolean;
  push_enabled?: boolean;
  enabled?: boolean;
  created_at?: string;
  updated_at?: string;
};

type PriceAlertsResponse = {
  alerts?: PriceAlertRow[];
};

const CONDITION_OPTIONS: Array<{
  value: AlertCondition;
  label: string;
  unit: 'price' | 'percent';
}> = [
  { value: 'price_above', label: '가격 이상', unit: 'price' },
  { value: 'price_below', label: '가격 이하', unit: 'price' },
  { value: 'change_above', label: '등락률 이상', unit: 'percent' },
  { value: 'change_below', label: '등락률 이하', unit: 'percent' },
];

function conditionOf(row: PriceAlertRow): AlertCondition {
  if (CONDITION_OPTIONS.some((item) => item.value === row.condition_type)) {
    return row.condition_type as AlertCondition;
  }
  return row.direction === 'below' ? 'price_below' : 'price_above';
}

function targetOf(row: PriceAlertRow): number {
  return Number(row.target_value ?? row.target_price);
}

export function PriceAlertCard({
  assetType,
  market,
  symbol,
  currentPrice,
  currency,
}: {
  assetType: 'stock' | 'coin_spot' | 'coin_futures';
  market: string;
  symbol: string;
  currentPrice: number | null;
  currency: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [targetValue, setTargetValue] = useState('');
  const [conditionType, setConditionType] =
    useState<AlertCondition>('price_above');
  const [enabled, setEnabled] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const alerts = useQuery({
    queryKey: ['notification-price-alerts'],
    queryFn: () =>
      apiGet<PriceAlertsResponse>('/notifications/price-alerts'),
    staleTime: 30_000,
  });

  const rows = useMemo(
    () =>
      (alerts.data?.alerts ?? []).filter(
        (row) =>
          row.symbol.toUpperCase() === symbol.toUpperCase() &&
          row.asset_type === assetType,
      ),
    [alerts.data?.alerts, assetType, symbol],
  );

  useEffect(() => {
    if (editingId && !rows.some((row) => row.id === editingId)) {
      setEditingId(null);
      setTargetValue('');
    }
  }, [editingId, rows]);

  const reset = () => {
    setEditingId(null);
    setTargetValue('');
    setConditionType('price_above');
    setEnabled(true);
  };

  const save = async () => {
    const value = Number(targetValue);
    const isPrice = conditionType.startsWith('price_');
    if (!Number.isFinite(value) || (isPrice && value <= 0)) {
      setMessage(isPrice ? '목표 가격을 입력해 주세요.' : '목표 등락률을 입력해 주세요.');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await authorizedFetch(
        editingId
          ? `/api/notifications/price-alerts/${encodeURIComponent(editingId)}`
          : '/api/notifications/price-alerts',
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assetType,
            market,
            symbol,
            conditionType,
            targetValue: value,
            repeatEnabled: false,
            appEnabled: enabled,
            pushEnabled: enabled,
            enabled,
          }),
        },
      );
      if (!response.ok) throw new Error(String(response.status));
      reset();
      setMessage(editingId ? '수정되었습니다.' : '저장되었습니다.');
      await queryClient.invalidateQueries({
        queryKey: ['notification-price-alerts'],
      });
    } catch {
      setMessage('저장 실패 — 로그인 상태와 네트워크를 확인해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  const edit = (row: PriceAlertRow) => {
    setEditingId(row.id);
    setConditionType(conditionOf(row));
    setTargetValue(String(targetOf(row)));
    setEnabled(row.enabled !== false);
    setOpen(true);
    setMessage(null);
  };

  const remove = async (id: string) => {
    try {
      const response = await authorizedFetch(
        `/api/notifications/price-alerts/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) throw new Error(String(response.status));
      if (editingId === id) reset();
      await queryClient.invalidateQueries({
        queryKey: ['notification-price-alerts'],
      });
    } catch {
      setMessage('삭제 실패 — 잠시 후 다시 시도해 주세요.');
    }
  };

  const selected = CONDITION_OPTIONS.find(
    (item) => item.value === conditionType,
  )!;
  const summary = alerts.isLoading
    ? '알림 조회 중'
    : rows.length > 0
      ? `저장된 알림 ${rows.length}건`
      : '저장된 알림 없음';

  return (
    <section className="rounded-3xl border border-card-border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 p-4"
      >
        <span className="flex-1 text-center">
          <span className="inline-flex items-center justify-center gap-1 text-sm font-black">
            <Bell className="h-4 w-4 text-primary" /> 가격·등락률 알림
          </span>
          {!open && (
            <span className="mt-0.5 block text-[10px] font-bold text-muted-foreground">
              {summary}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="space-y-3 px-4 pb-4 text-center">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-secondary/60 p-2">
              <p className="text-[10px] font-bold text-muted-foreground">현재가</p>
              <p className="mt-0.5 text-xs font-black">
                {currentPrice != null
                  ? `${currentPrice.toLocaleString()} ${currency}`
                  : '데이터 없음'}
              </p>
            </div>
            <input
              type="number"
              inputMode="decimal"
              value={targetValue}
              onChange={(event) => setTargetValue(event.target.value)}
              placeholder={selected.unit === 'percent' ? '목표 등락률(%)' : '목표 가격'}
              className="rounded-xl border border-card-border bg-background p-2 text-center text-xs font-bold outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            {CONDITION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setConditionType(option.value)}
                className={cn(
                  'rounded-xl border px-2 py-2 text-[11px] font-black',
                  conditionType === option.value
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-card-border bg-background text-muted-foreground',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setEnabled((value) => !value)}
            className={cn(
              'w-full rounded-xl border px-2 py-2 text-[11px] font-black',
              enabled
                ? 'border-positive bg-positive/10 text-positive'
                : 'border-card-border bg-background text-muted-foreground',
            )}
          >
            {enabled ? '알림 활성화' : '알림 비활성화'}
          </button>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-2xl bg-primary py-2.5 text-xs font-black text-primary-foreground disabled:opacity-50"
            >
              {saving ? '저장 중' : editingId ? '알림 수정' : '알림 저장'}
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-2xl border border-card-border py-2.5 text-xs font-black"
            >
              취소
            </button>
          </div>

          {message && (
            <p className="text-[11px] font-bold text-muted-foreground">{message}</p>
          )}
          {alerts.isError && (
            <p className="rounded-xl bg-destructive/10 p-2 text-[11px] font-bold text-destructive">
              알림 조회 실패 — 로그인 상태를 확인해 주세요.
            </p>
          )}

          {rows.map((row) => {
            const condition = CONDITION_OPTIONS.find(
              (item) => item.value === conditionOf(row),
            )!;
            const target = targetOf(row);
            return (
              <div
                key={row.id}
                className="flex items-center gap-2 rounded-2xl bg-secondary/60 p-3"
              >
                <div className="min-w-0 flex-1 text-center">
                  <p className="text-xs font-black">
                    {condition.label} {Number.isFinite(target) ? target.toLocaleString() : '-'}
                    {condition.unit === 'percent' ? '%' : ` ${currency}`}
                  </p>
                  <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
                    {row.enabled === false ? '비활성' : '활성'} ·{' '}
                    {row.updated_at
                      ? `수정 ${new Date(row.updated_at).toLocaleString('ko-KR')}`
                      : row.created_at
                        ? `등록 ${new Date(row.created_at).toLocaleString('ko-KR')}`
                        : '시각 없음'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => edit(row)}
                  aria-label="알림 수정"
                  className="rounded-xl border border-card-border p-2"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void remove(row.id)}
                  aria-label="알림 삭제"
                  className="rounded-xl border border-card-border p-2 text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}

          {!alerts.isLoading && !alerts.isError && rows.length === 0 && (
            <p className="text-[11px] font-bold text-muted-foreground">
              이 종목에 저장된 알림이 없습니다.
            </p>
          )}
          <p className="text-[10px] font-bold text-muted-foreground">
            알림은 시세 감시용이며 실제 주문을 실행하지 않습니다.
          </p>
        </div>
      )}
    </section>
  );
}
