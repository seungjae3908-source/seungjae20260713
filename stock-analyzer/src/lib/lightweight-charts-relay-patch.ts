// @ts-nocheck
import { createChart as createBaseChart } from 'lightweight-charts-original';

export * from 'lightweight-charts-original';

const PATTERN_COLORS = new Set(['#eab308', '#f97316', '#22c55e', '#ef4444']);

type Explanation = {
  title: string;
  summary: string;
  reasons: string[];
  caution: string;
};

function numericTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function isPatternRailOptions(options: Record<string, unknown> | undefined): boolean {
  if (!options) return false;
  return (
    options.lineWidth === 3 &&
    options.priceLineVisible === false &&
    options.lastValueVisible === false &&
    options.crosshairMarkerVisible === false &&
    PATTERN_COLORS.has(String(options.color ?? '').toLowerCase())
  );
}

function explanationForPriceLine(title: string): Explanation {
  if (title.includes('목표가')) {
    return {
      title,
      summary: '현재 분석 방향과 추세가 유지될 때 우선 확인하는 예상 도달 가격입니다.',
      reasons: [
        '최근 추세 방향과 지지·저항 구간을 함께 반영합니다.',
        '거래량과 기술지표가 현재 방향을 유지하는지 확인합니다.',
        'AI 분석 계획에서 계산된 목표 구간을 차트 가격선으로 표시합니다.',
      ],
      caution: '목표가는 확정 수익 가격이 아니며 추세가 바뀌면 함께 변경될 수 있습니다.',
    };
  }
  if (title.includes('손절')) {
    return {
      title,
      summary: '현재 분석 시나리오가 무효화됐다고 판단하는 위험관리 가격입니다.',
      reasons: [
        '최근 저점·고점과 주요 지지·저항 이탈 여부를 반영합니다.',
        '현재 분석 방향의 무효화 조건을 가격으로 표시합니다.',
        '한 번의 거래에서 손실이 과도하게 커지는 것을 막기 위한 기준입니다.',
      ],
      caution: '급격한 변동이나 갭이 발생하면 실제 체결 가격은 손절가와 달라질 수 있습니다.',
    };
  }
  if (title.includes('분할매수') || title.includes('차 매수')) {
    return {
      title,
      summary: '한 가격에 전부 진입하지 않고 여러 구간으로 나눠 위험을 분산하는 매수 기준입니다.',
      reasons: [
        '현재 가격과 지지 구간 사이를 단계별 진입 가격으로 나눕니다.',
        '가격 변동성이 클 때 평균 진입가격과 진입 위험을 분산합니다.',
        '각 단계는 현재 분석 계획의 매수 후보 가격을 사용합니다.',
      ],
      caution: '손절 기준이 무너지면 다음 단계 분할매수를 중단해야 합니다.',
    };
  }
  if (title.includes('분할매도') || title.includes('차 매도')) {
    return {
      title,
      summary: '목표 구간에서 수익 실현을 여러 단계로 나누는 매도 기준입니다.',
      reasons: [
        '저항 구간과 예상 목표 범위를 단계별 가격으로 나눕니다.',
        '전량 매도로 인한 기회 손실과 미실현 이익 반납 위험을 함께 줄입니다.',
        '각 단계는 현재 분석 계획의 매도 후보 가격을 사용합니다.',
      ],
      caution: '분할매도 가격은 고정된 최고점 예측이 아니며 시장 상황에 따라 조정될 수 있습니다.',
    };
  }
  return {
    title: title || '가격 기준',
    summary: '현재 분석에서 중요하게 판단한 가격 구간입니다.',
    reasons: ['지지·저항, 추세, 거래량과 기술지표를 함께 확인한 가격입니다.'],
    caution: '가격 기준은 참고용이며 실제 주문을 실행하지 않습니다.',
  };
}

function explanationForSeries(options: Record<string, unknown>): Explanation {
  const color = String(options.color ?? '').toLowerCase();
  const known: Record<string, [string, string, string[]]> = {
    '#f59e0b': ['SMA5', '최근 5개 봉의 단순 평균가격으로 단기 방향을 확인합니다.', ['가격이 SMA5 위에 있으면 단기 강세, 아래에 있으면 단기 약세 가능성을 봅니다.', '짧은 기간이라 가격 변화에 빠르게 반응하지만 거짓 신호도 많을 수 있습니다.']],
    '#8b5cf6': ['SMA20·추세선', '중기 평균가격과 추세의 중심을 확인하는 지표입니다.', ['최근 20개 봉의 평균 흐름을 기준으로 현재 가격의 위치를 비교합니다.', '가격이 평균선을 돌파하거나 이탈하는지 다른 지표와 함께 확인합니다.']],
    '#10b981': ['SMA60', '최근 60개 봉의 평균가격으로 중장기 추세를 확인합니다.', ['가격과 SMA60의 위치 관계로 큰 추세 방향을 확인합니다.', '단기선과 장기선의 배열이 같은 방향인지 확인합니다.']],
    '#ec4899': ['SMA120', '최근 120개 봉의 평균가격으로 장기 기준선을 확인합니다.', ['장기 추세의 지지·저항 역할을 하는지 확인합니다.', '단기 움직임보다 큰 방향 판단에 사용합니다.']],
    '#facc15': ['EMA9', '최근 가격에 더 큰 가중치를 주는 빠른 단기 평균선입니다.', ['최근 가격 변화에 SMA보다 빠르게 반응합니다.', '가격과 EMA9의 교차를 단기 변화 신호로 참고합니다.']],
    '#fb7185': ['EMA20', '최근 가격에 가중치를 둔 중기 추세 평균선입니다.', ['단기 방향과 중기 추세가 일치하는지 확인합니다.', 'EMA9와의 배열·교차를 함께 봅니다.']],
    '#34d399': ['EMA60', '최근 가격에 가중치를 둔 중장기 추세 기준선입니다.', ['가격이 EMA60 위에서 유지되는지 확인합니다.', '단기선이 장기선 위나 아래에 배열되는지 확인합니다.']],
    '#64748b': ['볼린저밴드 중심선', '최근 평균가격을 중심으로 변동 범위를 해석합니다.', ['중심선은 보통 20개 봉 평균이며 추세의 중심 역할을 합니다.', '상단·하단 밴드와 가격 위치를 함께 확인합니다.']],
    '#06b6d4': ['볼린저밴드', '가격 변동성이 만든 예상 상단·하단 범위를 표시합니다.', ['밴드 폭이 넓어지면 변동성 확대, 좁아지면 변동성 축소로 봅니다.', '밴드 접촉만으로 매수·매도를 결정하지 않고 추세를 함께 봅니다.']],
    '#f97316': ['VWAP·변동성 지표', '거래량이 반영된 평균가격 또는 현재 변동성 기준을 확인합니다.', ['가격과 거래량의 관계를 반영한 평균 수준을 확인합니다.', '현재 가격이 평균보다 위인지 아래인지 다른 지표와 함께 판단합니다.']],
    '#ef4444': ['전환선·강세 지표', '짧은 기간의 고가와 저가 중심으로 빠른 추세 변화를 확인합니다.', ['단기 가격 범위의 중심이 상승하는지 확인합니다.', '기준선과의 교차를 추세 변화 참고 신호로 사용합니다.']],
    '#3b82f6': ['기준선·약세 지표', '중기 가격 범위의 중심으로 추세 기준을 확인합니다.', ['가격이 기준선을 지지하거나 이탈하는지 확인합니다.', '전환선과의 배열을 함께 확인합니다.']],
    '#22c55e': ['선행스팬 A', '단기와 중기 기준의 평균을 미래 구간에 표시해 지지·저항을 봅니다.', ['구름대의 한쪽 경계를 구성합니다.', '다른 선행스팬과의 위치 관계로 추세 강도를 확인합니다.']],
    '#a855f7': ['후행스팬', '현재 종가를 과거 위치에 표시해 과거 가격과 비교합니다.', ['후행스팬이 과거 가격 위에 있으면 강세 가능성을 확인합니다.', '구름대와 다른 선의 방향도 함께 봅니다.']],
  };
  const entry = known[color] ?? ['기술지표', '가격·거래량 데이터를 계산해 현재 시장 상태를 보여주는 지표입니다.', ['한 개 지표만으로 결론내리지 않고 추세와 거래량, 다른 지표를 함께 확인합니다.']];
  return {
    title: String(options.title ?? entry[0]),
    summary: entry[1],
    reasons: entry[2],
    caution: '기술지표는 과거 데이터를 계산한 참고값이며 미래 가격을 보장하지 않습니다.',
  };
}

function showExplanationModal(explanation: Explanation): void {
  document.getElementById('chart-indicator-explanation-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'chart-indicator-explanation-modal';
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '140',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    background: 'rgba(0,0,0,.68)',
  });

  const panel = document.createElement('section');
  Object.assign(panel.style, {
    position: 'relative',
    width: '100%',
    maxWidth: '430px',
    maxHeight: '86vh',
    overflowY: 'auto',
    borderRadius: '24px',
    border: '1px solid rgba(148,163,184,.28)',
    background: 'var(--background, #0f172a)',
    color: 'var(--foreground, #f8fafc)',
    padding: '20px',
    boxShadow: '0 24px 80px rgba(0,0,0,.45)',
  });

  const close = () => overlay.remove();
  overlay.addEventListener('click', close);
  panel.addEventListener('click', (event) => event.stopPropagation());

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '닫기');
  closeButton.textContent = '×';
  Object.assign(closeButton.style, {
    position: 'absolute',
    top: '12px',
    right: '12px',
    width: '36px',
    height: '36px',
    borderRadius: '999px',
    border: '1px solid rgba(148,163,184,.35)',
    background: 'rgba(148,163,184,.12)',
    color: 'inherit',
    fontSize: '24px',
    fontWeight: '800',
    cursor: 'pointer',
  });
  closeButton.addEventListener('click', close);

  const reasons = explanation.reasons
    .map(
      (reason, index) =>
        `<div style="margin-top:8px;padding:10px 12px;border-radius:14px;background:rgba(148,163,184,.10);font-size:12px;font-weight:700;line-height:1.55">${index + 1}. ${reason}</div>`,
    )
    .join('');

  panel.innerHTML = `
    <div style="padding-right:42px">
      <div style="font-size:10px;font-weight:900;color:#8b5cf6">근거와 설명</div>
      <h3 style="margin:4px 0 0;font-size:20px;font-weight:900">${explanation.title}</h3>
    </div>
    <p style="margin:16px 0 0;padding:12px 14px;border-radius:16px;background:rgba(148,163,184,.12);font-size:13px;font-weight:700;line-height:1.6">${explanation.summary}</p>
    <h4 style="margin:18px 0 0;font-size:13px;font-weight:900">왜 이렇게 표시되나요?</h4>
    ${reasons}
    <div style="margin-top:16px;padding:12px 14px;border-radius:16px;border:1px solid rgba(245,158,11,.35);background:rgba(245,158,11,.10);color:#f59e0b;font-size:11px;font-weight:700;line-height:1.55">${explanation.caution}</div>
    <button type="button" data-modal-bottom-close style="margin-top:18px;width:100%;height:44px;border:0;border-radius:16px;background:#7c3aed;color:white;font-size:14px;font-weight:900;cursor:pointer">닫기</button>
  `;
  panel.prepend(closeButton);
  panel.querySelector('[data-modal-bottom-close]')?.addEventListener('click', close);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

export function createChart(container: HTMLElement, options?: Record<string, unknown>) {
  const chart = createBaseChart(container, options as never) as any;
  const originalAddCandlestickSeries = chart.addCandlestickSeries.bind(chart);
  const originalAddLineSeries = chart.addLineSeries.bind(chart);
  const originalRemoveSeries = chart.removeSeries.bind(chart);

  let mainCandleSeries: any = null;
  let focusCandleSeries: any = null;
  let mainCandles: any[] = [];
  let relayChartDetected = false;
  const patternRanges = new Map<any, { start: number; end: number }>();
  const lineExplanations = new Map<any, Explanation>();
  const priceLines: Array<{ price: number; title: string; explanation: Explanation }> = [];

  const ensureFocusSeries = () => {
    if (focusCandleSeries) return focusCandleSeries;
    focusCandleSeries = originalAddCandlestickSeries({
      upColor: '#b91c1c',
      downColor: '#1d4ed8',
      wickUpColor: '#991b1b',
      wickDownColor: '#1e40af',
      borderUpColor: '#7f1d1d',
      borderDownColor: '#1e3a8a',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    return focusCandleSeries;
  };

  const updateStoredCandle = (bar: any) => {
    const time = numericTime(bar?.time);
    if (time == null) return;
    const index = mainCandles.findIndex((item) => numericTime(item?.time) === time);
    if (index >= 0) mainCandles[index] = bar;
    else mainCandles.push(bar);
  };

  chart.addCandlestickSeries = (seriesOptions: Record<string, unknown> = {}) => {
    const series = originalAddCandlestickSeries(seriesOptions);

    if (!mainCandleSeries) {
      mainCandleSeries = series;
      const originalSetData = series.setData.bind(series);
      const originalUpdate = series.update.bind(series);
      const originalCreatePriceLine = series.createPriceLine.bind(series);
      const originalRemovePriceLine = series.removePriceLine.bind(series);

      series.setData = (data: any[]) => {
        mainCandles = Array.isArray(data) ? data.map((item) => ({ ...item })) : [];
        return originalSetData(data);
      };

      series.update = (bar: any) => {
        updateStoredCandle({ ...bar });
        return originalUpdate(bar);
      };

      series.createPriceLine = (lineOptions: Record<string, unknown>) => {
        const title = String(lineOptions?.title ?? '').trim();
        const price = Number(lineOptions?.price);
        if (relayChartDetected && String(lineOptions?.color ?? '').toLowerCase() === '#eab308') {
          return originalCreatePriceLine({
            ...lineOptions,
            color: 'rgba(234,179,8,0)',
            axisLabelVisible: false,
            title: '',
          });
        }
        const line = originalCreatePriceLine(lineOptions);
        if (Number.isFinite(price) && title) {
          priceLines.push({ price, title, explanation: explanationForPriceLine(title) });
        }
        return line;
      };

      series.removePriceLine = (line: any) => {
        const options = typeof line?.options === 'function' ? line.options() : null;
        const price = Number(options?.price);
        const title = String(options?.title ?? '');
        const index = priceLines.findIndex((item) => item.price === price && item.title === title);
        if (index >= 0) priceLines.splice(index, 1);
        return originalRemovePriceLine(line);
      };
    }

    return series;
  };

  chart.addLineSeries = (seriesOptions: Record<string, unknown> = {}) => {
    const patternRail = isPatternRailOptions(seriesOptions);
    const series = originalAddLineSeries(
      patternRail ? { ...seriesOptions, visible: false } : seriesOptions,
    );

    if (patternRail) {
      relayChartDetected = true;
      ensureFocusSeries();
      const originalSetData = series.setData.bind(series);

      series.setData = (data: any[]) => {
        if (Array.isArray(data) && data.length >= 2) {
          const start = numericTime(data[0]?.time);
          const end = numericTime(data[data.length - 1]?.time);
          if (start != null && end != null) {
            patternRanges.set(series, {
              start: Math.min(start, end),
              end: Math.max(start, end),
            });
          }
        }
        return originalSetData([]);
      };
    } else if (seriesOptions.priceScaleId !== 'volume') {
      lineExplanations.set(series, explanationForSeries(seriesOptions));
    }

    return series;
  };

  chart.removeSeries = (series: any) => {
    patternRanges.delete(series);
    lineExplanations.delete(series);
    if (series === focusCandleSeries) focusCandleSeries = null;
    return originalRemoveSeries(series);
  };

  chart.subscribeClick((param: any) => {
    for (const [series, explanation] of lineExplanations) {
      if (param?.seriesData?.has?.(series)) {
        showExplanationModal(explanation);
        return;
      }
    }

    if (!param?.point || !mainCandleSeries || priceLines.length === 0) return;
    const y = Number(param.point.y);
    if (!Number.isFinite(y)) return;
    const nearest = priceLines
      .map((item) => ({
        item,
        distance: Math.abs(Number(mainCandleSeries.priceToCoordinate(item.price)) - y),
      }))
      .filter((entry) => Number.isFinite(entry.distance))
      .sort((left, right) => left.distance - right.distance)[0];
    if (nearest && nearest.distance <= 12) showExplanationModal(nearest.item.explanation);
  });

  const timeScale = chart.timeScale();
  const originalSetVisibleLogicalRange = timeScale.setVisibleLogicalRange.bind(timeScale);

  const highlightSelectedPattern = (range: { from: number; to: number }) => {
    if (!relayChartDetected || !mainCandles.length || !patternRanges.size) return;
    const focusSeries = ensureFocusSeries();
    const centerIndex = Math.max(
      0,
      Math.min(mainCandles.length - 1, Math.round((range.from + range.to) / 2)),
    );
    const centerTime = numericTime(mainCandles[centerIndex]?.time);
    if (centerTime == null) return;

    const selectedRange = [...patternRanges.values()].sort((left, right) => {
      const leftDistance = Math.abs(left.start - centerTime);
      const rightDistance = Math.abs(right.start - centerTime);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left.end - left.start - (right.end - right.start);
    })[0];

    let selected = selectedRange
      ? mainCandles.filter((candle) => {
          const time = numericTime(candle?.time);
          return time != null && time >= selectedRange.start && time <= selectedRange.end;
        })
      : [];

    if (!selected.length) {
      selected = mainCandles.slice(
        Math.max(0, centerIndex - 2),
        Math.min(mainCandles.length, centerIndex + 3),
      );
    }

    focusSeries.setData(selected);
  };

  timeScale.setVisibleLogicalRange = (range: { from: number; to: number }) => {
    const result = originalSetVisibleLogicalRange(range);
    const width = Number(range?.to) - Number(range?.from);
    if (
      relayChartDetected &&
      Number.isFinite(width) &&
      width >= 20 &&
      width <= 50.5
    ) {
      queueMicrotask(() => highlightSelectedPattern(range));
    }
    return result;
  };

  return chart;
}
