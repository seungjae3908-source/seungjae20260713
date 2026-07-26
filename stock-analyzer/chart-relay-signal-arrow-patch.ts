import type { Plugin } from 'vite';

function insertSignalArrowHelpers(source: string): string {
  if (source.includes('type SignalArrowEntry =')) return source;

  const marker = 'function signalPrediction(signal: ChartSignal): string {';
  const index = source.indexOf(marker);
  if (index < 0) {
    throw new Error('[chart-relay-signal-arrow-patch] 신호 화살표 헬퍼 삽입 위치를 찾지 못했습니다.');
  }

  const helpers = `type SignalArrowEntry = {
  signal: ChartSignal;
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown';
  color: string;
};

function signalArrowPriority(signal: ChartSignal): number {
  const stageWeight: Record<ChartSignal['stage'], number> = {
    START: 1,
    DEVELOPING: 2,
    COMPLETED: 4,
    INVALIDATED: 5,
  };
  const importanceWeight =
    signalImportance(signal.importance) === 'high'
      ? 4
      : signalImportance(signal.importance) === 'medium'
        ? 2
        : 1;
  return stageWeight[signal.stage] + importanceWeight;
}

function signalIsBearish(signal: ChartSignal): boolean {
  return (
    signal.stage === 'INVALIDATED' ||
    /하락|매도|약세|이탈|쌍봉|이중천장|석별|유성|데드크로스/.test(signal.name)
  );
}

function signalArrowEntries(
  signals: ChartSignal[],
  candles: CandlePoint[],
): SignalArrowEntry[] {
  if (candles.length === 0) return [];

  const strongestByTime = new Map<number, SignalArrowEntry>();
  const candidates = dedupeSignalOccurrences(signals)
    .filter((signal) => signal.kind === 'chart' || signal.kind === 'candle')
    .sort(
      (left, right) =>
        (toEpochMilliseconds(left.occurredAt) ?? 0) -
        (toEpochMilliseconds(right.occurredAt) ?? 0),
    )
    .slice(-30);

  for (const signal of candidates) {
    const target = toUnixSeconds(
      signal.overlay?.fromTime ?? signal.barTime ?? signal.occurredAt,
    );
    if (target == null) continue;

    const nearest = candles.reduce((current, candle) =>
      Math.abs(Number(candle.time) - target) <
      Math.abs(Number(current.time) - target)
        ? candle
        : current,
    );
    const time = Number(nearest.time);
    const bearish = signalIsBearish(signal);
    const entry: SignalArrowEntry = {
      signal,
      time,
      position: bearish ? 'aboveBar' : 'belowBar',
      shape: bearish ? 'arrowDown' : 'arrowUp',
      color: PATTERN_STAGE_META[signal.stage].color,
    };
    const existing = strongestByTime.get(time);
    if (
      !existing ||
      signalArrowPriority(signal) > signalArrowPriority(existing.signal)
    ) {
      strongestByTime.set(time, entry);
    }
  }

  return [...strongestByTime.values()]
    .sort((left, right) => left.time - right.time)
    .slice(-20);
}

`;

  return source.slice(0, index) + helpers + source.slice(index);
}

function replaceClickHandler(source: string): string {
  const start = source.indexOf(
    '    const clickHandler = (param: MouseEventParams<Time>) => {',
  );
  const subscribe = source.indexOf(
    '    chart.subscribeClick(clickHandler);',
    start,
  );
  if (start < 0 || subscribe < 0) {
    throw new Error('[chart-relay-signal-arrow-patch] 차트 클릭 처리 위치를 찾지 못했습니다.');
  }

  const replacement = `    const clickHandler = (param: MouseEventParams<Time>) => {
      if (typeof param.time !== 'number' || !param.point) return;

      const arrow = signalArrowEntries(
        signalsRef.current,
        candlesRef.current,
      ).find((item) => item.time === Number(param.time));
      if (!arrow) return;

      const candle = candlesRef.current.find(
        (item) => Number(item.time) === arrow.time,
      );
      if (!candle) return;

      const priceSeries =
        previousChartTypeRef.current === 'line'
          ? closeSeriesRef.current
          : candleSeriesRef.current;
      if (!priceSeries) return;

      const anchorPrice =
        arrow.position === 'aboveBar' ? candle.high : candle.low;
      const anchorY = priceSeries.priceToCoordinate(anchorPrice);
      if (anchorY == null) return;

      const clickedY = Number(param.point.y);
      const insideArrowArea =
        arrow.position === 'aboveBar'
          ? clickedY >= anchorY - 38 && clickedY <= anchorY + 5
          : clickedY >= anchorY - 5 && clickedY <= anchorY + 38;
      if (!insideArrowArea) return;

      onSignalSelectRef.current(arrow.signal);
    };
`;

  return source.slice(0, start) + replacement + source.slice(subscribe);
}

function replaceSignalMarkers(source: string): string {
  const markerStart = source.indexOf(
    '    const markers: SeriesMarker<Time>[] = [];',
  );
  const pricePlanStart = source.indexOf(
    "    if (tab === 'live' && plan) {",
    markerStart,
  );
  if (markerStart < 0 || pricePlanStart < 0) {
    throw new Error('[chart-relay-signal-arrow-patch] 신호 마커 또는 가격 계획 위치를 찾지 못했습니다.');
  }

  const markerBlock = `    const markers: SeriesMarker<Time>[] = [];

    if (tab === 'live' && settings.highlight && candles.length > 0) {
      for (const arrow of signalArrowEntries(signals, candles)) {
        markers.push({
          time: arrow.time as Time,
          position: arrow.position,
          color: arrow.color,
          shape: arrow.shape,
          text: '',
        });
      }
    }

`;

  let code =
    source.slice(0, markerStart) +
    markerBlock +
    source.slice(pricePlanStart);

  const activeMarkerStart = code.indexOf(
    '      const rawMarkerTime = toUnixSeconds(overlay?.fromTime ?? signal?.barTime);',
  );
  const markerApply = code.indexOf('    series.setMarkers(', activeMarkerStart);
  if (activeMarkerStart >= 0 && markerApply >= 0) {
    code =
      code.slice(0, activeMarkerStart) +
      '    }\n' +
      code.slice(markerApply);
  }

  const setMarkersStart = code.indexOf('    series.setMarkers(');
  if (setMarkersStart < 0) {
    throw new Error('[chart-relay-signal-arrow-patch] setMarkers 적용 위치를 찾지 못했습니다.');
  }
  const multilineEnd = code.indexOf('\n    );', setMarkersStart);
  if (multilineEnd >= 0) {
    code =
      code.slice(0, setMarkersStart) +
      '    series.setMarkers(markers);' +
      code.slice(multilineEnd + '\n    );'.length);
  } else {
    const inlineEnd = code.indexOf(');', setMarkersStart);
    if (inlineEnd < 0) {
      throw new Error('[chart-relay-signal-arrow-patch] setMarkers 종료 위치를 찾지 못했습니다.');
    }
    code =
      code.slice(0, setMarkersStart) +
      '    series.setMarkers(markers);' +
      code.slice(inlineEnd + 2);
  }

  return code;
}

function restorePositivePriceLines(source: string): string {
  let code = source;

  code = code.replace(
    `        if (!candidate.on || candidate.price == null || !Number.isFinite(candidate.price)) continue;`,
    `        if (
          !candidate.on ||
          candidate.price == null ||
          !Number.isFinite(candidate.price) ||
          candidate.price <= 0
        ) continue;`,
  );

  code = code.replace(
    `            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,`,
    `            lineWidth: line.titles.some((title) => title === '목표가' || title === '손절가') ? 2 : 1,
            lineStyle: line.titles.some((title) => title === '목표가' || title === '손절가')
              ? LineStyle.Solid
              : LineStyle.Dashed,
            axisLabelVisible: true,`,
  );

  return code;
}

function patchChartRelay(source: string): string {
  let code = insertSignalArrowHelpers(source);
  code = replaceClickHandler(code);
  code = replaceSignalMarkers(code);
  code = restorePositivePriceLines(code);
  return code;
}

export function chartRelaySignalArrowPatch(): Plugin {
  return {
    name: 'chart-relay-signal-arrow-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/pages/chart-relay.tsx')) return null;
      return {
        code: patchChartRelay(source),
        map: null,
      };
    },
  };
}
