type FavoriteButtonProps = {
  symbol?: string;
  name?: string;
  assetType?: string;
  className?: string;
};

export function FavoriteButton({
  className = '',
}: FavoriteButtonProps) {
  return (
    <button
      type="button"
      className={className}
      aria-label="관심종목"
      title="관심종목"
    >
      ☆
    </button>
  );
}
