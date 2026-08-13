import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useLocation } from 'wouter';
import { fetchStrategyPromotions } from '@/lib/strategy-promotion';

export function StrategyPromotionBadge({ compact = false }: { compact?: boolean }) {
  const [, navigate] = useLocation();
  const query = useQuery({
    queryKey: ['strategy-promotion', 'summary'],
    queryFn: ({ signal }) => fetchStrategyPromotions(signal),
    staleTime: 60_000,
  });
  const candidates = query.data?.promotionCandidates ?? 0;
  const label = query.isError
    ? 'Promotion evidence unavailable'
    : query.isPending
      ? 'Promotion evidence loading'
      : candidates > 0
        ? `${candidates} promotion candidate${candidates === 1 ? '' : 's'}`
        : 'Promotion candidates: none';

  return (
    <button
      type="button"
      data-testid="strategy-promotion-badge"
      onClick={() => navigate('/strategy-promotion')}
      className="inline-flex min-h-10 max-w-full items-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-3 text-left text-[11px] font-black text-primary"
      aria-label={`${label}. Open Strategy Promotion Center`}
    >
      <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{compact ? (candidates > 0 ? `${candidates} candidate` : 'Promotion: none') : label}</span>
    </button>
  );
}
