import { useEffect, useState } from 'react';
import { Bell, Loader2, Smartphone, X } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import {
  ALERT_LABELS,
  ALERT_TIMEFRAMES,
  normalizeAlertSetting,
  type AlertAssetType,
  type InstrumentAlertSetting,
  type InstrumentAlertSettingsResponse,
} from '@/lib/instrument-alerts';
import { subscribeToPush } from '@/lib/notifications';
import { cn } from '@/lib/utils';

const CONTROL_CLASS = 'h-10 min-w-0 w-full rounded-xl border border-card-border bg-background px-2 text-xs font-bold text-foreground outline-none focus:border-primary';

export interface InstrumentIdentity {
  ticker: string;
  name: string;
  market: string;
  assetType?: AlertAssetType;
}

function endpointOf(instrument: InstrumentIdentity): string {
  return `/api/notifications/instruments/${encodeURIComponent(instrument.assetType ?? 'stock')}/${encodeURIComponent(instrument.market)}/${encodeURIComponent(instrument.ticker)}`;
}

export function InstrumentAlertButton({ instrument }: { instrument: InstrumentIdentity }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-card-border bg-background text-muted-foreground hover:border-primary/50 hover:text-primary"
        aria-label={`${instrument.name} 알림 설정`}
      >
        <Bell className="h-4 w-4" />
      </button>
      {open ? <InstrumentAlertModal instrument={instrument} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function InstrumentAlertModal({
  instrument,
  onClose,
}: {
  instrument: InstrumentIdentity;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<InstrumentAlertSetting[]>([]);
  const [vapidReady, setVapidReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    void authorizedFetch(endpointOf(instrument))
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(payload?.message ?? payload?.error ?? '알림 설정을 불러오지 못했습니다.'));
        if (!active) return;
        const result = payload as InstrumentAlertSettingsResponse;
        setSettings(result.settings.map(normalizeAlertSetting));
        setVapidReady(result.vapidReady === true);
      })
      .catch((error) => active && setMessage(error instanceof Error ? error.message : '알림 설정을 불러오지 못했습니다.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [instrument.assetType, instrument.market, instrument.ticker]);

  const update = (index: number, changes: Partial<InstrumentAlertSetting>) => {
    setSettings((current) => current.map((setting, rowIndex) => rowIndex === index ? { ...setting, ...changes } : setting));
  };

  const ensurePushSubscription = async () => {
    const result = await subscribeToPush(async (subscription) => {
      const response = await authorizedFetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription),
      });
      if (!response.ok) throw new Error('휴대폰 푸시 구독 저장에 실패했습니다.');
      return response.json();
    });
    if (!result.ok) throw new Error(result.message);
  };

  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      if (settings.some((setting) => setting.pushEnabled)) {
        if (!vapidReady) throw new Error('서버에 VAPID 자격증명이 없어 휴대폰 푸시를 켤 수 없습니다.');
        await ensurePushSubscription();
      }
      const response = await authorizedFetch(endpointOf(instrument), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrumentName: instrument.name, settings }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload?.message ?? payload?.error ?? '알림 설정 저장에 실패했습니다.'));
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '알림 설정 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="instrument-alert-title"
        className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-card-border bg-background shadow-2xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-card-border px-4 py-3">
          <Bell className="h-5 w-5 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 id="instrument-alert-title" className="truncate text-left font-black">{instrument.name} 알림 설정</h2>
            <p className="text-left text-xs text-muted-foreground">{instrument.ticker} · {instrument.market}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="닫기" className="rounded-full p-2 hover:bg-secondary">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
          {loading ? <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin" /></div> : null}
          {!loading && settings.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">현재 회원등급에서 설정할 수 있는 알림이 없습니다.</p> : null}
          <div className="space-y-2">
            {settings.map((setting, index) => (
              <details key={setting.alertType} className="rounded-2xl border border-card-border bg-card p-3" open={setting.enabled}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <span className="text-left text-sm font-bold">{ALERT_LABELS[setting.alertType]}</span>
                  <button
                    type="button"
                    onClick={(event) => { event.preventDefault(); update(index, { enabled: !setting.enabled }); }}
                    className={cn('rounded-full px-3 py-1 text-xs font-black', setting.enabled ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}
                  >
                    {setting.enabled ? 'ON' : 'OFF'}
                  </button>
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-2 text-left text-xs">
                  <Field label="시간 프레임">
                    <select value={setting.timeframe} onChange={(event) => update(index, { timeframe: event.target.value })} className={CONTROL_CLASS}>
                      {ALERT_TIMEFRAMES.map((timeframe) => <option key={timeframe}>{timeframe}</option>)}
                    </select>
                  </Field>
                  {(setting.alertType === 'target_price' || setting.alertType === 'change_rate') ? (
                    <Field label={setting.alertType === 'target_price' ? '지정 가격' : '등락률(%)'}>
                      <input type="number" value={setting.triggerValue ?? ''} onChange={(event) => update(index, { triggerValue: event.target.value === '' ? null : Number(event.target.value) })} className={CONTROL_CLASS} />
                    </Field>
                  ) : null}
                  <Field label="최소 신뢰도(%)"><input type="number" min="0" max="100" value={setting.minConfidence} onChange={(event) => update(index, { minConfidence: Number(event.target.value) })} className={CONTROL_CLASS} /></Field>
                  <Field label="최소 조건 개수"><input type="number" min="1" max="20" value={setting.minConditionCount} onChange={(event) => update(index, { minConditionCount: Number(event.target.value) })} className={CONTROL_CLASS} /></Field>
                  <Field label="재발송 간격(분)"><input type="number" min="1" max="10080" value={setting.cooldownMinutes} onChange={(event) => update(index, { cooldownMinutes: Number(event.target.value) })} className={CONTROL_CLASS} /></Field>
                  <Field label="휴대폰 푸시">
                    <button type="button" disabled={!vapidReady} onClick={() => update(index, { pushEnabled: !setting.pushEnabled })} className={cn(CONTROL_CLASS, 'flex items-center justify-center gap-1', setting.pushEnabled && 'text-primary', !vapidReady && 'opacity-50')}>
                      <Smartphone className="h-3.5 w-3.5" /> {setting.pushEnabled ? '사용' : '미사용'}
                    </button>
                  </Field>
                  <Field label="알림 허용 시작"><input type="time" value={setting.allowedStart ?? ''} onChange={(event) => update(index, { allowedStart: event.target.value || null })} className={CONTROL_CLASS} /></Field>
                  <Field label="알림 허용 종료"><input type="time" value={setting.allowedEnd ?? ''} onChange={(event) => update(index, { allowedEnd: event.target.value || null })} className={CONTROL_CLASS} /></Field>
                  <Field label="방해금지 시작"><input type="time" value={setting.dndStart ?? ''} onChange={(event) => update(index, { dndStart: event.target.value || null })} className={CONTROL_CLASS} /></Field>
                  <Field label="방해금지 종료"><input type="time" value={setting.dndEnd ?? ''} onChange={(event) => update(index, { dndEnd: event.target.value || null })} className={CONTROL_CLASS} /></Field>
                </div>
              </details>
            ))}
          </div>
          {message ? <p className="mt-3 rounded-xl bg-destructive/10 p-3 text-left text-xs font-bold text-destructive">{message}</p> : null}
          {!vapidReady ? <p className="mt-3 text-left text-[11px] text-muted-foreground">서버 푸시 자격증명이 없어 휴대폰 푸시는 비활성화되어 있습니다. 앱 내부 설정은 저장할 수 있습니다.</p> : null}
        </div>

        <footer className="grid shrink-0 grid-cols-2 gap-2 border-t border-card-border bg-background p-3">
          <button type="button" onClick={onClose} className="rounded-2xl border border-card-border px-4 py-3 text-sm font-bold">취소</button>
          <button type="button" onClick={() => void save()} disabled={loading || saving} className="rounded-2xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground disabled:opacity-50">{saving ? '저장 중…' : '저장'}</button>
        </footer>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-muted-foreground"><span>{label}</span>{children}</label>;
}
