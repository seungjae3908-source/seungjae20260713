import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { ScannerSavedSearchManager } from '@/components/scanner-saved-search-manager';
import { useAssetMode } from '@/lib/asset-mode';
import AiChartPage from '@/pages/ai-chart';
import AutoTradingPage from '@/pages/auto-trading';
import CryptoFuturesScannerPage from '@/pages/crypto-futures-scanner';
import CryptoSpotScannerPage from '@/pages/crypto-spot-scanner';
import ScannerPage from '@/pages/scanner';

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

export default function TechnicalWorkspacePage() {
  const desktop = useDesktopWorkspace();
  const [location] = useLocation();
  const assetMode = useAssetMode();

  if (location.startsWith('/auto-trading')) return <AutoTradingPage />;
  if (assetMode.asset === 'coin') {
    return assetMode.coinMarket === 'futures'
      ? <CryptoFuturesScannerPage />
      : <CryptoSpotScannerPage />;
  }
  if (!desktop) return <><ScannerPage /><ScannerSavedSearchManager /></>;
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(340px,0.72fr)_minmax(0,2fr)] overflow-hidden bg-background pb-20">
      <aside className="min-h-0 overflow-hidden border-r border-card-border"><ScannerPage embedded /></aside>
      <section className="min-h-0 overflow-hidden"><AiChartPage embedded /></section>
      <ScannerSavedSearchManager />
      <BottomNav />
    </div>
  );
}
