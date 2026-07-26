import type { Plugin } from 'vite';

function patchChartRelay(source: string): string {
  let code = source;

  code = code
    .replace("label: 'Minutes'", "label: '분봉'")
    .replace("label: 'Hours'", "label: '시간봉'")
    .replace("label: 'Days'", "label: '일봉'")
    .replace("label: 'Weeks'", "label: '주봉'")
    .replace("label: 'Months'", "label: '월봉'")
    .replace("label: 'Years'", "label: '연봉'")
    .replace("? 'Candle Settings'", "? '캔들 설정'")
    .replace(
      'Select one timeframe. Closed-market and no-trade periods do not create artificial candles.',
      '봉 주기를 하나 선택하세요. 휴장과 거래 없음 구간에는 임의 캔들을 만들지 않습니다.',
    )
    .replace("{panel === 'candle' ? 'Cancel' : '취소'}", '취소')
    .replace("{panel === 'candle' ? 'Apply' : '적용'}", '적용')
    .replace(
      '마커·밑줄 구간을 누르면 신호 상세가 열립니다.',
      '화살표를 누르면 신호 상세가 열립니다.',
    );

  code = code.replace(
    'className="fixed inset-0 z-[95] flex items-end justify-center bg-black/60 p-3"',
    'className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-2 sm:p-3"',
  );
  code = code.replace(
    'className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-card-border bg-background p-4"',
    'className="max-h-[calc(100dvh-16px)] w-full max-w-md overscroll-contain overflow-y-auto rounded-2xl border border-card-border bg-background p-4 sm:max-h-[90vh]"',
  );

  code = code.replace(
    'className="flex min-h-[52px] flex-wrap items-center justify-between gap-2 border-b border-card-border px-2 py-2"',
    'className="flex min-h-[52px] flex-col items-stretch gap-2 border-b border-card-border px-2 py-2 sm:flex-row sm:items-center sm:justify-between"',
  );
  code = code.replace(
    'className="flex flex-wrap gap-1"',
    'className="grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] gap-1 sm:flex sm:w-auto sm:flex-wrap"',
  );
  code = code.replace(
    'className="rounded-lg border border-card-border bg-card px-2 py-1 text-[10px] font-black"',
    'className="min-w-0 w-full rounded-lg border border-card-border bg-card px-2 py-1 text-[10px] font-black sm:w-auto"',
  );
  code = code.replace(
    'className="inline-flex items-center rounded-lg border border-card-border bg-card px-2 py-1 text-[10px] font-black text-primary"',
    'className="inline-flex min-w-0 items-center justify-center rounded-lg border border-card-border bg-card px-2 py-1 text-[10px] font-black text-primary"',
  );
  code = code.replace(
    'className="flex items-center gap-1.5"',
    'className="flex w-full items-center justify-end gap-1.5 sm:w-auto"',
  );

  code = code.replace(
    `        <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">\n          매수·매도 판단 근거와 지난 신호를 탭별로 확인합니다.\n        </p>\n`,
    '',
  );
  code = code.replace(
    `            <p className="mt-3 rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2 text-center text-[10px] font-black text-warning">\n              AI 신호와 추천 가격은 참고용이며 실제 주문을 실행하지 않습니다.\n            </p>\n`,
    '',
  );

  return code;
}

function patchPriceAlerts(source: string): string {
  return source
    .replace(
      `            <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">\n              앱을 열어 둔 동안 가격이 목표가·분할매수·분할매도·손절가에 닿으면 즉시 알립니다.\n            </p>\n`,
      '',
    )
    .replace(
      `        <p className="mt-2 text-[9px] font-bold leading-4 text-muted-foreground">\n          현재 구현은 앱이 열려 있을 때 동작합니다. 앱을 완전히 닫은 상태의 백그라운드 푸시는 별도 서버 푸시 연결이 필요합니다.\n        </p>\n`,
      '',
    );
}

export function chartRelayMobileUiCleanupPatch(): Plugin {
  return {
    name: 'chart-relay-mobile-ui-cleanup-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];

      if (normalized.endsWith('/src/pages/chart-relay.tsx')) {
        return { code: patchChartRelay(source), map: null };
      }

      if (normalized.endsWith('/src/components/chart-relay-price-alerts.tsx')) {
        return { code: patchPriceAlerts(source), map: null };
      }

      return null;
    },
  };
}
