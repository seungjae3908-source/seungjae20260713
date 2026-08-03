import { useEffect, useState } from 'react';
import { BottomNav } from '@/components/bottom-nav';
import AiChartPage from '@/pages/ai-chart';
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
  if (!desktop) return <ScannerPage />;
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(340px,0.72fr)_minmax(0,2fr)] overflow-hidden bg-background pb-20">
      <aside className="min-h-0 overflow-hidden border-r border-card-border"><ScannerPage embedded /></aside>
      <section className="min-h-0 overflow-hidden"><AiChartPage embedded /></section>
      <BottomNav />
    </div>
  );
}
