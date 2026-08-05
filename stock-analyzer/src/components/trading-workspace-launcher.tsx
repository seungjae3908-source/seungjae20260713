import { useCallback, useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import { useLocation } from 'wouter';
import {
  selectionFromSearch,
  selectionQuery,
  useAnalysisSelection,
  type AnalysisSelection,
} from '@/lib/analysis-selection';

function fallbackSelection(): AnalysisSelection {
  return {
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    ticker: '005930',
    displayName: '삼성전자',
    timeframe: '5m',
    selectedAt: new Date().toISOString(),
  };
}

export function TradingWorkspaceLauncher() {
  const [location, navigate] = useLocation();
  const state = useAnalysisSelection();
  const fromUrl = useMemo(
    () => selectionFromSearch(location.includes('?') ? location.slice(location.indexOf('?')) : ''),
    [location],
  );
  const selection = useMemo<AnalysisSelection>(
    () => fromUrl
      ? { ...(state.selection?.ticker === fromUrl.ticker ? state.selection : {}), ...fromUrl }
      : state.selection ?? fallbackSelection(),
    [fromUrl, state.selection],
  );
  const supported = selection.assetType === 'stock'
    && (selection.market === 'KR' || selection.market === 'US');

  const openTradingWorkspace = useCallback(() => {
    if (!supported) return;
    const workspacePath = `/trading-workspace?${selectionQuery(selection)}`;
    if (typeof window === 'undefined' || window.innerWidth < 1024) {
      navigate(workspacePath);
      return;
    }
    const popup = window.open(
      workspacePath,
      'ai-trading-workspace',
      'popup,width=1440,height=900,resizable=yes,scrollbars=yes',
    );
    if (popup) {
      popup.opener = null;
      popup.focus();
      return;
    }
    navigate(workspacePath);
  }, [navigate, selection, supported]);

  if (!supported) return null;

  return (
    <button
      type="button"
      data-testid="open-ai-trading-workspace"
      onClick={openTradingWorkspace}
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+5.25rem)] right-4 z-50 flex min-h-11 items-center justify-center gap-2 rounded-full border border-primary/30 bg-background/95 px-4 text-xs font-black text-primary shadow-lg backdrop-blur hover:bg-primary/10 md:bottom-6"
    >
      <ExternalLink className="h-4 w-4" aria-hidden />
      AI 매매창 열기
    </button>
  );
}
