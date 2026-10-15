import { useCallback, useState } from 'react';
import { ScannerApprovalComposer } from '@/components/scanner-approval-composer';
import { SignalOrderWindow } from '@/components/signal-order-window';
import type { AnalysisSelection } from '@/lib/analysis-selection';
import type { EntryGuardResult } from '@/lib/signal-entry-guard';
import type { LivePriceMarket } from '@/lib/signal-live-price';
import type { ScannerPricePlan } from '@/lib/signal-scanner';

type GuardedSignalOrderProps = {
  market: LivePriceMarket | null;
  symbol: string;
  name?: string | null;
  action?: string | null;
  pricePlan: ScannerPricePlan;
  selection: AnalysisSelection;
};

/**
 * One order window for both the scanner and Telegram entry points: live price
 * + entry guard on top, and the order button below follows the guard.
 */
export function GuardedSignalOrder({ market, symbol, name, action, pricePlan, selection }: GuardedSignalOrderProps) {
  const [guard, setGuard] = useState<EntryGuardResult | null>(null);
  const onGuardChange = useCallback((next: EntryGuardResult) => setGuard(next), []);
  const direction = action === 'BUY' || action === 'LONG' || action === 'SHORT' ? action : null;

  if (!market || !direction) return <ScannerApprovalComposer selection={selection} />;
  return (
    <div className="space-y-3">
      <SignalOrderWindow
        market={market}
        symbol={symbol}
        name={name}
        action={direction}
        pricePlan={{ entryZone: pricePlan.entryZone, stopLoss: pricePlan.stopLoss, targets: pricePlan.targets }}
        onGuardChange={onGuardChange}
      />
      <ScannerApprovalComposer
        selection={selection}
        entryGuard={guard ? { allowed: guard.allowed, message: guard.message } : { allowed: false, message: '현재가를 확인하는 중이에요.' }}
      />
    </div>
  );
}
