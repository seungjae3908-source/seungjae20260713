import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { CapabilityGate } from '@/components/capability-gate';
import { ScannerSavedSearchManager } from '@/components/scanner-saved-search-manager';
import { useAssetMode } from '@/lib/asset-mode';
import AiChartPage from '@/pages/ai-chart';
import AutoTradingPage from '@/pages/auto-trading';
import CryptoFuturesScannerPage from '@/pages/crypto-futures-scanner';
import CryptoSpotScannerPage from '@/pages/crypto-spot-scanner';
import ScannerPage from '@/pages/scanner';
import SignalScannerPage from '@/pages/signal-scanner';
import type { MemberCapability } from '../../../packages/member-access/src/index.js';

type MobileWorkspace = 'signal' | 'legacy';

function useDesktopWorkspace() {
  const query = '(min-width: 1024px)';
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return desktop;
}

function gated(bypass: boolean, capability: MemberCapability, child: ReactNode) {
  return bypass ? <>{child}</> : <CapabilityGate capability={capability}>{child}</CapabilityGate>;
}

export default function TechnicalWorkspacePage() {
  const desktop = useDesktopWorkspace();
  const [location] = useLocation();
  const assetMode = useAssetMode();
  const phase11SignalRoute = location.startsWith('/__phase11-technical-workspace-e2e');
  const [mobileWorkspace, setMobileWorkspace] = useState<MobileWorkspace>(() => phase11SignalRoute ? 'signal' : 'legacy');

  if (location.startsWith('/auto-trading')) {
    return gated(phase11SignalRoute, 'canAccessPaperTrading', <AutoTradingPage />);
  }
  if (assetMode.asset === 'coin') {
    return assetMode.coinMarket === 'futures'
      ? gated(phase11SignalRoute, 'canAccessFutures', <CryptoFuturesScannerPage />)
      : gated(phase11SignalRoute, 'canAccessSpot', <CryptoSpotScannerPage />);
  }
  if (!desktop) {
    return gated(
      phase11SignalRoute,
      'canAccessRiskPreview',
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <div className="shrink-0 border-b border-card-border bg-background px-3 py-2">
          {mobileWorkspace === 'legacy' ? (
            <button
              type="button"
              onClick={() => setMobileWorkspace('signal')}
              className="min-h-11 w-full rounded-xl border border-primary/30 bg-primary/10 px-3 text-sm font-extrabold text-primary"
            >
              다중 시장 AI 신호검색기
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setMobileWorkspace('legacy')}
              className="min-h-11 w-full rounded-xl border border-card-border bg-card px-3 text-sm font-extrabold"
            >
              AI 차트·자동매매 워크스페이스
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {mobileWorkspace === 'legacy' ? <ScannerPage /> : <SignalScannerPage />}
        </div>
        {mobileWorkspace === 'signal' ? <ScannerSavedSearchManager /> : null}
      </div>,
    );
  }
  return gated(
    phase11SignalRoute,
    'canAccessRiskPreview',
    <div className="grid h-full min-h-0 grid-cols-[minmax(380px,0.88fr)_minmax(0,2fr)] overflow-hidden bg-background pb-20">
      <aside className="min-h-0 overflow-hidden border-r border-card-border"><SignalScannerPage embedded /></aside>
      <section className="min-h-0 overflow-hidden"><AiChartPage embedded /></section>
      <ScannerSavedSearchManager />
      <BottomNav />
    </div>,
  );
}
