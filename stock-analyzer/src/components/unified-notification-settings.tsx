import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell, Plus, Smartphone, Trash2 } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';
import {
  getPermissionLabel,
  getVapidPublicKey,
  isPushSupported,
  requestNotificationPermission,
  showLocalNotification,
  subscribeToPush,
} from '@/lib/notifications';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;
const TYPE_LABELS: Record<string, string> = {
  news_positive: '호재 뉴스',
  news_negative: '악재 뉴스',
  disclosure_positive: '호재 공시',
  disclosure_negative: '악재 공시',
  ai_strong_buy: 'AI 강력매수 신호',
  ai_sell_signal: 'AI 매도·위험 신호',
  golden_cross: '골든크로스',
  volume_surge: '거래량 급증',
  capital_event: '증자·오퍼링·CB·BW',
  price_target: '지정가 도달',
  auto_trade: '자동매매 주문·체결·청산',
  system: '시스템·API 장애',
};

export function UnifiedNotificationSettings() {
  const preferences = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => apiGet<AnyObj>('/notifications/preferences'),
    retry: false,
  });
  const priceAlerts = useQuery({
    queryKey: ['notification-price-alerts'],
    queryFn: () => apiGet<AnyObj>('/notifications/price-alerts'),
    retry: false,
  });
  const [enabledTypes, setEnabledTypes] = useState<string[]>(Object.keys(TYPE_LABELS));
  const [appEnabled, setAppEnabled] = useState(true);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [status, setStatus] = useState(getPermissionLabel());
  const [assetType, setAssetType] = useState<'stock' | 'coin_spot' | 'coin_futures'>('stock');
  const [market, setMarket] = useState('KR');
  const [symbol, setSymbol] = useState('');
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [targetPrice, setTargetPrice] = useState('');
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const row = preferences.data?.preferences;
    if (!row) return;
    if (Array.isArray(row.enabled_types)) setEnabledTypes(row.enabled_types.map(String));
    setAppEnabled(row.app_enabled !== false);
    setPushEnabled(row.push_enabled === true);
  }, [preferences.data]);

  const savePreferences = async (next: { enabledTypes?: string[]; appEnabled?: boolean; pushEnabled?: boolean }) => {
    const body = {
      enabledTypes: next.enabledTypes ?? enabledTypes,
      appEnabled: next.appEnabled ?? appEnabled,
      pushEnabled: next.pushEnabled ?? pushEnabled,
    };
    const response = await authorizedFetch('/api/notifications/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('알림 설정을 서버에 저장하지 못했습니다.');
    await preferences.refetch();
  };

  const toggleType = async (key: string) => {
    const next = enabledTypes.includes(key) ? enabledTypes.filter((item) => item !== key) : [...enabledTypes, key];
    setEnabledTypes(next);
    try { await savePreferences({ enabledTypes: next }); setStatus('알림 종류를 계정에 저장했습니다.'); }
    catch (error) { setStatus(error instanceof Error ? error.message : '저장 실패'); }
  };

  const requestPermission = async () => {
    const result = await requestNotificationPermission();
    setStatus(result.message);
    if (result.ok) showLocalNotification('지식정보 알림 설정', '브라우저 알림 권한이 허용되었습니다.');
  };

  const enablePush = async () => {
    if (!getVapidPublicKey()) { setStatus('서버 VAPID 키 설정이 필요합니다.'); return; }
    const result = await subscribeToPush(async (subscription) => {
      const response = await authorizedFetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription) });
      if (!response.ok) throw new Error('푸시 구독 저장 실패');
      return response.json();
    });
    setStatus(result.message);
    if (result.ok) { setPushEnabled(true); await savePreferences({ pushEnabled: true }); }
  };

  const createPriceAlert = async () => {
    const price = Number(targetPrice);
    if (!symbol.trim() || !Number.isFinite(price) || price <= 0) { setStatus('심볼과 목표가격을 정확히 입력해 주세요.'); return; }
    setSaving(true);
    try {
      const response = await authorizedFetch('/api/notifications/price-alerts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetType, market, symbol: symbol.trim().toUpperCase(), direction, targetPrice: price, repeatEnabled, appEnabled, pushEnabled }),
      });
      if (!response.ok) throw new Error('지정가 알림 저장에 실패했습니다.');
      setSymbol(''); setTargetPrice(''); setStatus('지정가 알림을 계정에 저장했습니다.'); await priceAlerts.refetch();
    } catch (error) { setStatus(error instanceof Error ? error.message : '지정가 알림 저장 실패'); }
    finally { setSaving(false); }
  };

  const deletePriceAlert = async (id: string) => {
    const response = await authorizedFetch(`/api/notifications/price-alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (response.ok) await priceAlerts.refetch();
  };

  const alertRows = useMemo(() => (priceAlerts.data?.alerts ?? []) as AnyObj[], [priceAlerts.data]);

  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
      <div><h2 className="text-sm font-extrabold">통합 알림 설정</h2><p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">주식·코인·자동매매·시스템 알림을 회원 계정별로 저장합니다.</p></div>
      {preferences.isError && <p className="mt-3 rounded-2xl bg-warning/10 p-3 text-xs font-bold text-warning">Supabase 통합 알림 마이그레이션 적용이 필요합니다.</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => void requestPermission()} className="flex items-center justify-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-3 text-xs font-extrabold text-primary"><Smartphone className="h-4 w-4" />권한 허용</button>
        <button type="button" onClick={() => void enablePush()} disabled={!isPushSupported()} className="flex items-center justify-center gap-2 rounded-2xl border border-positive/40 bg-positive/10 p-3 text-xs font-extrabold text-positive disabled:opacity-50"><Bell className="h-4 w-4" />푸시 구독</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Toggle label="앱 안 알림" active={appEnabled} onClick={() => { const next = !appEnabled; setAppEnabled(next); void savePreferences({ appEnabled: next }); }} />
        <Toggle label="푸시 알림" active={pushEnabled} onClick={() => { const next = !pushEnabled; setPushEnabled(next); void savePreferences({ pushEnabled: next }); }} />
      </div>
      <p className="mt-2 text-[10px] font-bold text-muted-foreground">현재 상태: {status}</p>

      <details className="mt-4 rounded-2xl border border-card-border bg-background p-3" open>
        <summary className="cursor-pointer text-xs font-black">알림 종류 설정</summary>
        <div className="mt-3 grid grid-cols-1 gap-2">
          {Object.entries(TYPE_LABELS).map(([key, label]) => <Toggle key={key} label={label} active={enabledTypes.includes(key)} onClick={() => void toggleType(key)} />)}
        </div>
      </details>

      <details className="mt-3 rounded-2xl border border-card-border bg-background p-3">
        <summary className="cursor-pointer text-xs font-black">지정가 알림 설정</summary>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <select value={assetType} onChange={(event) => { const value = event.target.value as typeof assetType; setAssetType(value); setMarket(value === 'stock' ? 'KR' : value === 'coin_spot' ? 'UPBIT' : 'BITGET'); }} className="rounded-xl border border-card-border bg-card p-2 text-xs font-bold"><option value="stock">주식</option><option value="coin_spot">코인 현물</option><option value="coin_futures">코인 선물</option></select>
          <input value={market} onChange={(event) => setMarket(event.target.value.toUpperCase())} placeholder="시장" className="rounded-xl border border-card-border bg-card p-2 text-xs font-bold" />
          <input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="종목코드·심볼" className="rounded-xl border border-card-border bg-card p-2 text-xs font-bold" />
          <select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)} className="rounded-xl border border-card-border bg-card p-2 text-xs font-bold"><option value="above">가격 이상</option><option value="below">가격 이하</option></select>
          <input type="number" value={targetPrice} onChange={(event) => setTargetPrice(event.target.value)} placeholder="목표가격" className="rounded-xl border border-card-border bg-card p-2 text-xs font-bold" />
          <Toggle label="반복 알림" active={repeatEnabled} onClick={() => setRepeatEnabled((current) => !current)} />
        </div>
        <button type="button" onClick={() => void createPriceAlert()} disabled={saving} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary p-3 text-xs font-black text-primary-foreground disabled:opacity-50"><Plus className="h-4 w-4" />{saving ? '저장 중' : '지정가 알림 추가'}</button>
        <div className="mt-3 space-y-2">{alertRows.map((row) => <div key={String(row.id)} className="flex items-center gap-3 rounded-2xl bg-card p-3"><div className="min-w-0 flex-1"><p className="truncate text-xs font-black">{row.symbol} · {row.direction === 'above' ? '이상' : '이하'} {Number(row.target_price).toLocaleString()}</p><p className="mt-1 text-[10px] font-bold text-muted-foreground">{row.asset_type} · {row.market} · {row.repeat_enabled ? '반복' : '1회'}</p></div><button type="button" onClick={() => void deletePriceAlert(String(row.id))} className="rounded-xl border border-card-border p-2 text-destructive"><Trash2 className="h-4 w-4" /></button></div>)}</div>
      </details>
    </section>
  );
}

function Toggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={cn('flex items-center justify-between gap-2 rounded-xl border p-2 text-left text-xs font-bold', active ? 'border-primary/40 bg-primary/10 text-primary' : 'border-card-border bg-card text-muted-foreground')}><span>{label}</span><span className={cn('h-5 w-9 rounded-full p-0.5', active ? 'bg-primary' : 'bg-muted')}><span className={cn('block h-4 w-4 rounded-full bg-background transition-transform', active && 'translate-x-4')} /></span></button>;
}
