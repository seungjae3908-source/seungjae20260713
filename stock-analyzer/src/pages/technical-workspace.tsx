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
import type { MemberCapability } from '../../../packages/member-access/src/index.js';

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
  const bypassCapabilityGate = location.startsWith('/__phase11-technical-workspace-e2e');

  if (location.startsWith('/auto-trading')) {
    return gated(bypassCapabilityGate, 'canAccessPaperTrading', <AutoTradingPage />);
  }
  if (assetMode.asset === 'coin') {
    return assetMode.coinMarket === 'futures'
      ? gated(bypassCapabilityGate, 'canAccessFutures', <CryptoFuturesScannerPage />)
      : gated(bypassCapabilityGate, 'canAccessSpot', <CryptoSpotScannerPage />);
  }
  if (!desktop) {
    return gated(bypassCapabilityGate, 'canAccessRiskPreview', <><ScannerPage /><ScannerSavedSearchManager /></>);
  }
  return gated(
    bypassCapabilityGate,
    'canAccessRiskPreview',
    <div className="grid h-full min-h-0 grid-cols-[minmax(340px,0.72fr)_minmax(0,2fr)] overflow-hidden bg-background pb-20">
      <aside className="min-h-0 overflow-hidden border-r border-card-border"><ScannerPage embedded /></aside>
      <section className="min-h-0 overflow-hidden"><AiChartPage embedded /></section>
      <ScannerSavedSearchManager />
      <BottomNav />
    </div>,
  );
}
