import { ShieldCheck } from 'lucide-react';
import { useLocation } from 'wouter';

export function StrategyPromotionBadge({ compact = false }: { compact?: boolean }) {
  const [, navigate] = useLocation();
  const label = 'Open Strategy Promotion Center';

  return (
    <button
      type="button"
      data-testid="strategy-promotion-badge"
      onClick={() => navigate('/strategy-promotion')}
      className="inline-flex min-h-10 max-w-full items-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-3 text-left text-[11px] font-black text-primary"
      aria-label={label}
    >
      <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{compact ? 'Promotion Center' : 'Strategy Promotion Center'}</span>
    </button>
  );
}
