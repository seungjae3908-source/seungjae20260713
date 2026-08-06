import { useCallback, useEffect, useState } from 'react';
import {
  deleteScannerSavedSearch,
  loadScannerSavedSearchStore,
  saveScannerSavedSearch,
  type ScannerSavedSearch,
  type ScannerSavedSearchStore,
} from '@/lib/scanner-saved-searches';

const DEFAULT_SEARCH: ScannerSavedSearch = {
  id: 'fixture-kr-15m',
  name: '국내주식 15분 검색',
  assetClass: 'stock',
  market: 'KR',
  symbols: ['005930'],
  timeframe: '15m',
  selected: ['TREND', 'VOLUME'],
  alertEnabled: true,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

export function ScannerSavedSearchManager({
  userId,
  candidate = DEFAULT_SEARCH,
}: {
  userId: string;
  candidate?: ScannerSavedSearch;
}) {
  const [store, setStore] = useState<ScannerSavedSearchStore>({ revision: 0, items: [] });
  const [message, setMessage] = useState('');

  const reload = useCallback(() => {
    try {
      setStore(loadScannerSavedSearchStore(userId));
      setMessage('');
    } catch {
      setStore({ revision: 0, items: [] });
      setMessage('사용자 정보를 확인할 수 없어 저장 검색을 잠갔습니다.');
    }
  }, [userId]);

  useEffect(() => { reload(); }, [reload]);

  function save(next: ScannerSavedSearch) {
    const result = saveScannerSavedSearch(userId, store.revision, next);
    if (!result.ok) {
      setMessage(result.error === 'SAVED_SEARCH_DUPLICATE'
        ? '같은 시장·종목·시간봉·조건의 저장 검색이 이미 있습니다.'
        : result.error === 'SAVED_SEARCH_CONFLICT'
          ? '다른 변경이 먼저 저장됐습니다. 목록을 다시 불러왔습니다.'
          : '저장 검색을 저장할 수 없습니다.');
      reload();
      return;
    }
    setStore(result.store);
    setMessage('저장 검색이 반영됐습니다.');
  }

  function remove(id: string) {
    const result = deleteScannerSavedSearch(userId, store.revision, id);
    if (!result.ok) {
      setMessage(result.error === 'SAVED_SEARCH_CONFLICT'
        ? '삭제 중 목록이 변경돼 다시 불러왔습니다.'
        : '존재하지 않는 저장 검색입니다.');
      reload();
      return;
    }
    setStore(result.store);
    setMessage('저장 검색을 삭제했습니다.');
  }

  return (
    <section aria-labelledby="saved-search-heading" className="rounded-2xl border border-card-border bg-card p-4" data-testid="scanner-saved-search-manager">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="saved-search-heading" className="text-sm font-black">저장 검색</h2>
          <p className="mt-1 text-xs text-muted-foreground">사용자별로 시장·종목·시간봉·알림 여부를 분리해 저장합니다.</p>
        </div>
        <button
          type="button"
          onClick={() => save({ ...candidate, updatedAt: new Date().toISOString() })}
          className="min-h-11 rounded-xl border border-primary/30 bg-primary/10 px-3 text-xs font-extrabold text-primary"
        >
          현재 조건 저장
        </button>
      </div>
      {message ? <p role="status" className="mt-3 text-xs text-muted-foreground">{message}</p> : null}
      <div className="mt-3 space-y-2">
        {store.items.length === 0 ? <p className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">저장된 검색이 없습니다.</p> : null}
        {store.items.map((item) => (
          <article key={item.id} className="rounded-xl border border-card-border p-3" data-testid={`saved-search-${item.id}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-extrabold">{item.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.assetClass} · {item.market} · {item.symbols.join(', ') || '전체'} · {item.timeframe}</p>
              </div>
              <span className="rounded-full bg-muted px-2 py-1 text-[11px] font-bold">알림 {item.alertEnabled ? 'ON' : 'OFF'}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => save({ ...item, alertEnabled: !item.alertEnabled })}
                className="min-h-11 rounded-xl border border-card-border px-3 text-xs font-extrabold"
              >
                알림 {item.alertEnabled ? '끄기' : '켜기'}
              </button>
              <button
                type="button"
                onClick={() => remove(item.id)}
                className="min-h-11 rounded-xl border border-destructive/30 px-3 text-xs font-extrabold text-destructive"
              >
                삭제
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
