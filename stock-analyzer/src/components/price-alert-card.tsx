// 지정가 알림 카드 — 종목/코인 상세 화면에서 기존 price_alerts API를 그대로 사용한다.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Trash2 } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';
import { CollapsibleCard } from '@/components/collapsible-card';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;

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
  const [targetPrice, setTargetPrice] = useState('');
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const alerts = useQuery({
    queryKey: ['notification-price-alerts'],
    queryFn: () => apiGet<AnyObj>('/notifications/price-alerts'),
    staleTime: 30_000,
  });

  const rows = ((alerts.data?.alerts ?? []) as AnyObj[]).filter(
    (row) => String(row.symbol).toUpperCase() === symbol.toUpperCase() && String(row.asset_type) === assetType,
  );

  const save = async () => {
    const price = Number(targetPrice);
    if (!Number.isFinite(price) || price <= 0) { setMessage('목표 가격을 입력해 주세요.'); return; }
    setSaving(true);
    setMessage(null);
    try {
      const response = await authorizedFetch('/api/notifications/price-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetType,
          market,
          symbol,
          direction,
          targetPrice: price,
          repeatEnabled: false,
          appEnabled: enabled,
          pushEnabled: enabled,
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setTargetPrice('');
      setMessage('저장되었습니다.');
      await queryClient.invalidateQueries({ queryKey: ['notification-price-alerts'] });
    } catch {
      setMessage('저장 실패 — 로그인 상태와 네트워크를 확인해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const response = await authorizedFetch(`/api/notifications/price-alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(String(response.status));
      await queryClient.invalidateQueries({ queryKey: ['notification-price-alerts'] });
    } catch {
      setMessage('삭제 실패 — 잠시 후 다시 시도해 주세요.');
    }
  };

  return (
    <CollapsibleCard
      title={<span className="inline-flex items-center justify-center gap-1"><Bell className="h-4 w-4 text-primary" /> 지정가 알림</span>}
      summary={alerts.isLoading ? '알림 조회 중' : rows.length > 0 ? `저장된 알림 ${rows.length}건` : '저장된 알림 없음'}
    >
      <div className="space-y-3 text-center">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-secondary/60 p-2"><p className="text-[10px] font-bold text-muted-foreground">현재가</p><p className="mt-0.5 text-xs font-black">{currentPrice != null ? `${currentPrice.toLocaleString()} ${currency}` : '데이터 없음'}</p></div>
          <input type="number" inputMode="decimal" value={targetPrice} onChange={(e) => setTargetPrice(e.target.value)} placeholder="목표 가격" className="rounded-xl border border-card-border bg-background p-2 text-center text-xs font-bold outline-none" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={() => setDirection('above')} className={cn('rounded-xl border px-2 py-2 text-[11px] font-black', direction === 'above' ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background text-muted-foreground')}>이상 도달</button>
          <button type="button" onClick={() => setDirection('below')} className={cn('rounded-xl border px-2 py-2 text-[11px] font-black', direction === 'below' ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background text-muted-foreground')}>이하 도달</button>
          <button type="button" onClick={() => setEnabled((v) => !v)} className={cn('rounded-xl border px-2 py-2 text-[11px] font-black', enabled ? 'border-positive bg-positive/10 text-positive' : 'border-card-border bg-background text-muted-foreground')}>{enabled ? '알림 켜짐' : '알림 꺼짐'}</button>
        </div>
        <button type="button" onClick={() => void save()} disabled={saving} className="w-full rounded-2xl bg-primary py-2.5 text-xs font-black text-primary-foreground disabled:opacity-50">{saving ? '저장 중' : '알림 저장'}</button>
        {message && <p className="text-[11px] font-bold text-muted-foreground">{message}</p>}

        {alerts.isError && <p className="rounded-xl bg-destructive/10 p-2 text-[11px] font-bold text-destructive">알림 조회 실패 — 로그인 상태를 확인해 주세요.</p>}
        {rows.map((row) => (
          <div key={String(row.id)} className="flex items-center gap-2 rounded-2xl bg-secondary/60 p-3">
            <div className="min-w-0 flex-1 text-center">
              <p className="text-xs font-black">{row.direction === 'above' ? '이상' : '이하'} {Number(row.target_price).toLocaleString()} {currency}</p>
              <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
                {row.app_enabled || row.push_enabled ? '활성' : '비활성'} · {row.repeat_enabled ? '반복' : '1회'}
                {row.updated_at ? ` · 마지막 확인 ${new Date(String(row.updated_at)).toLocaleString('ko-KR')}` : row.created_at ? ` · 등록 ${new Date(String(row.created_at)).toLocaleString('ko-KR')}` : ''}
              </p>
            </div>
            <button type="button" onClick={() => void remove(String(row.id))} aria-label="알림 삭제" className="rounded-xl border border-card-border p-2 text-destructive"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        {!alerts.isLoading && !alerts.isError && rows.length === 0 && <p className="text-[11px] font-bold text-muted-foreground">이 종목에 저장된 알림이 없습니다.</p>}
      </div>
    </CollapsibleCard>
  );
}
