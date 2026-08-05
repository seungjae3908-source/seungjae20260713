import { useEffect, useState } from 'react';
import { Bookmark, RotateCcw, Save, Settings2, Trash2, X } from 'lucide-react';
import {
  deleteScannerSavedSearch,
  loadScannerSavedSearches,
  resetScannerSearchStorage,
  updateScannerSavedSearch,
  writeScannerSavedSearches,
  type ScannerSavedSearch,
} from '@/lib/scanner-saved-searches';

export function ScannerSavedSearchManager() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ScannerSavedSearch[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScannerSavedSearch | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (open) setItems(loadScannerSavedSearches());
  }, [open]);

  function beginEdit(item: ScannerSavedSearch) {
    setEditing(item.id);
    setDraft({ ...item, selected: [...item.selected] });
    setMessage('');
  }

  function saveDraft() {
    if (!draft || !editing) return;
    if (!draft.name.trim() || !draft.selected.length) {
      setMessage('이름과 조건을 한 개 이상 입력해 주세요.');
      return;
    }
    const next = updateScannerSavedSearch(items, editing, draft);
    const stored = writeScannerSavedSearches(next);
    setItems(stored);
    setEditing(null);
    setDraft(null);
    setMessage('저장 검색을 수정했습니다. 닫으면 검색기에 반영됩니다.');
  }

  function remove(item: ScannerSavedSearch) {
    if (!window.confirm(`저장 검색 “${item.name}”을 삭제하시겠습니까?`)) return;
    const next = writeScannerSavedSearches(deleteScannerSavedSearch(items, item.id));
    setItems(next);
    if (editing === item.id) {
      setEditing(null);
      setDraft(null);
    }
    setMessage('저장 검색을 삭제했습니다.');
  }

  function resetAll() {
    if (!window.confirm('저장 검색, 시장 선택, 거래량 기준을 모두 기본값으로 초기화하시겠습니까?')) return;
    resetScannerSearchStorage(window.localStorage);
    setItems([]);
    setEditing(null);
    setDraft(null);
    setMessage('검색 조건을 기본값으로 초기화했습니다.');
  }

  function closeAndRefresh() {
    setOpen(false);
    window.location.reload();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-24 right-4 z-40 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-card px-3 py-2 text-xs font-extrabold text-primary shadow-lg"
        aria-label="저장 검색 관리"
      >
        <Settings2 className="h-4 w-4" />저장 검색 관리
      </button>

      {open ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="저장 검색 관리">
          <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-card-border bg-card shadow-2xl">
            <header className="flex items-start justify-between gap-3 border-b border-card-border p-4">
              <div>
                <div className="flex items-center gap-2"><Bookmark className="h-5 w-5 text-primary" /><h2 className="text-base font-black">저장 검색 관리</h2></div>
                <p className="mt-1 text-xs text-muted-foreground">이름·시장·시간봉·조건·점수·위험 기준을 수정하거나 삭제합니다.</p>
              </div>
              <button type="button" onClick={closeAndRefresh} aria-label="저장 검색 관리 닫기" className="rounded-full bg-secondary p-2"><X className="h-4 w-4" /></button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {message ? <p role="status" className="mb-3 rounded-2xl bg-secondary p-3 text-xs font-bold">{message}</p> : null}
              {items.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-card-border bg-background p-5 text-center text-xs font-bold text-muted-foreground">저장된 검색 조건이 없습니다.</p>
              ) : (
                <div className="space-y-3">
                  {items.map((item) => {
                    const active = editing === item.id && draft;
                    return (
                      <article key={item.id} className="rounded-2xl border border-card-border bg-background p-3">
                        {active ? (
                          <div className="space-y-3">
                            <label className="block text-[10px] font-bold text-muted-foreground">이름<input aria-label="저장 검색 이름" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 w-full rounded-xl border border-card-border bg-card px-3 py-2 text-sm font-bold text-foreground outline-none" /></label>
                            <div className="grid grid-cols-2 gap-2">
                              <label className="text-[10px] font-bold text-muted-foreground">시장<select aria-label="저장 검색 시장" value={draft.market} onChange={(event) => setDraft({ ...draft, market: event.target.value === 'US' ? 'US' : 'KR' })} className="mt-1 w-full rounded-xl border border-card-border bg-card px-3 py-2 text-xs font-bold text-foreground"><option value="KR">국내</option><option value="US">미국</option></select></label>
                              <label className="text-[10px] font-bold text-muted-foreground">시간봉<select aria-label="저장 검색 시간봉" value={draft.timeframe} onChange={(event) => setDraft({ ...draft, timeframe: event.target.value as ScannerSavedSearch['timeframe'] })} className="mt-1 w-full rounded-xl border border-card-border bg-card px-3 py-2 text-xs font-bold text-foreground">{['5m', '15m', '1H', '4H', '1D'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                            </div>
                            <label className="block text-[10px] font-bold text-muted-foreground">조건 · 쉼표로 구분<textarea aria-label="저장 검색 조건" value={draft.selected.join(', ')} onChange={(event) => setDraft({ ...draft, selected: [...new Set(event.target.value.split(',').map((value) => value.trim()).filter(Boolean))].slice(0, 40) })} rows={3} className="mt-1 w-full rounded-xl border border-card-border bg-card px-3 py-2 text-xs font-bold text-foreground outline-none" /></label>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                              <NumberField label="최소 점수" value={draft.minimumScore} min={0} max={100} onChange={(value) => setDraft({ ...draft, minimumScore: value })} />
                              <NumberField label="최대 위험" value={draft.maximumRiskScore} min={0} max={100} onChange={(value) => setDraft({ ...draft, maximumRiskScore: value })} />
                              <NumberField label="거래량 증가%" value={draft.volumeThreshold} min={1} max={10000} onChange={(value) => setDraft({ ...draft, volumeThreshold: value })} />
                              <NumberField label="거래대금 증가%" value={draft.tradingValueThreshold} min={1} max={10000} onChange={(value) => setDraft({ ...draft, tradingValueThreshold: value })} />
                              <NumberField label="거래량 비교일" value={draft.volumeLookbackDays} min={1} max={250} onChange={(value) => setDraft({ ...draft, volumeLookbackDays: value })} />
                              <NumberField label="거래대금 비교일" value={draft.tradingValueLookbackDays} min={1} max={250} onChange={(value) => setDraft({ ...draft, tradingValueLookbackDays: value })} />
                              <NumberField label="최소 시총" value={draft.marketCapThreshold} min={0} max={Number.MAX_SAFE_INTEGER} onChange={(value) => setDraft({ ...draft, marketCapThreshold: value })} />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <button type="button" onClick={() => { setEditing(null); setDraft(null); }} className="rounded-xl border border-card-border px-3 py-2.5 text-xs font-extrabold">취소</button>
                              <button type="button" onClick={saveDraft} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2.5 text-xs font-extrabold text-primary-foreground"><Save className="h-4 w-4" />수정 저장</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-extrabold">{item.name}</p>
                              <p className="mt-1 text-[10px] font-bold text-muted-foreground">{item.market} · {item.timeframe} · 조건 {item.selected.length}개 · 점수 {item.minimumScore} 이상 · 위험 {item.maximumRiskScore} 이하</p>
                              <p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground">{item.selected.join(' · ')}</p>
                            </div>
                            <div className="flex shrink-0 gap-1">
                              <button type="button" onClick={() => beginEdit(item)} className="rounded-xl border border-card-border px-2.5 py-2 text-[10px] font-extrabold">수정</button>
                              <button type="button" onClick={() => remove(item)} aria-label={`${item.name} 삭제`} className="rounded-xl border border-destructive/30 p-2 text-destructive"><Trash2 className="h-4 w-4" /></button>
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>

            <footer className="grid grid-cols-2 gap-2 border-t border-card-border p-4">
              <button type="button" onClick={resetAll} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-destructive/30 px-3 py-2.5 text-xs font-extrabold text-destructive"><RotateCcw className="h-4 w-4" />전체 초기화</button>
              <button type="button" onClick={closeAndRefresh} className="rounded-xl bg-primary px-3 py-2.5 text-xs font-extrabold text-primary-foreground">닫고 반영</button>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label className="text-[10px] font-bold text-muted-foreground">{label}<input type="number" aria-label={label} min={min} max={max} value={value} onChange={(event) => onChange(Math.min(max, Math.max(min, Number(event.target.value) || 0)))} className="mt-1 w-full rounded-xl border border-card-border bg-card px-2 py-2 text-xs font-bold text-foreground outline-none" /></label>;
}
