import { lazy, Suspense } from 'react';

type CoinInfoProps = {
  nowMs: number;
  basePath?: string;
};

const LazyCoinInfo = lazy(() =>
  import('@/pages/stock-info').then(({ CoinInfo }) => ({ default: CoinInfo })),
);

export function CoinInfo(props: CoinInfoProps) {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          aria-label="코인 정보 불러오는 중"
          className="flex min-h-40 items-center justify-center px-4 text-sm font-bold text-muted-foreground"
        >
          코인 정보를 불러오는 중...
        </div>
      }
    >
      <LazyCoinInfo {...props} />
    </Suspense>
  );
}
