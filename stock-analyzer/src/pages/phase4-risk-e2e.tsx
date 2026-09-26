import { useState } from 'react';
import {
  CryptoTradingWorkspace,
  type CryptoWorkspaceViewMode,
} from '@/components/crypto-trading-workspace';

export default function Phase4RiskE2EPage() {
  const [viewMode, setViewMode] = useState<CryptoWorkspaceViewMode>('chart');

  return (
    <div data-testid="phase4-coin-futures-workspace" className="h-full min-w-0 overflow-hidden">
      <CryptoTradingWorkspace
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onBackToStock={() => undefined}
      />
    </div>
  );
}
