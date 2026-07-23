type InstrumentAlertButtonProps = {
  symbol?: string;
  name?: string;
  assetType?: string;
  currentPrice?: number;
  className?: string;
};

export function InstrumentAlertButton({
  className = '',
}: InstrumentAlertButtonProps) {
  return (
    <button
      type="button"
      className={className}
      aria-label="가격 알림"
      title="가격 알림"
    >
      알림
    </button>
  );
}
