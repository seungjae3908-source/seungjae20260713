import { BottomNav } from '@/components/bottom-nav';
import { PaperTradingPanel } from '@/components/paper-trading-panel';

export default function PaperTradingPage() {
  return <div className="relative h-full min-h-0 overflow-hidden"><PaperTradingPanel /><BottomNav /></div>;
}
