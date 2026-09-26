import { RATING_KO, ratingTone, toneBadge } from '@/lib/labels';
import type { Rating } from '@/lib/api';
import { cn } from '@/lib/utils';

export function RatingBadge({
  rating,
  confidence,
  size = 'sm',
}: {
  rating: Rating;
  confidence?: number;
  size?: 'sm' | 'md';
}) {
  const tone = ratingTone(rating);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-semibold',
        toneBadge(tone),
        size === 'md' ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-1 text-xs',
      )}
    >
      {RATING_KO[rating]}
      {confidence != null && <span className="font-normal opacity-70">{confidence}%</span>}
    </span>
  );
}
