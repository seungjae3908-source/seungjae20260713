import type { BacktestResult } from './backtest';

export type BacktestLossFinding = {
  key: string;
  title: string;
  value: string;
  detail: string;
  severity: 'high' | 'medium' | 'info';
};

export type BacktestLossAttribution = {
  status: 'LOSS' | 'PROFIT' | 'FLAT';
  findings: BacktestLossFinding[];
  losingTradeCount: number;
  grossLosingPnl: number;
  totalModeledCosts: number;
  worstSide: 'long' | 'short' | null;
  worstRegime: string | null;
  worstExitReason: string | null;
  worstMonth: string | null;
  validationWeakness: boolean;
  deterministic: true;
  externalAiCalled: false;
};

const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });

function money(value: number) {
  return number.format(value);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function groupLoss<T extends string>(rows: Array<{ key: T; pnl: number }>): Array<{ key: T; loss: number; count: number }> {
  const grouped = new Map<T, { loss: number; count: number }>();
  for (const row of rows) {
    if (!(row.pnl < 0)) continue;
    const current = grouped.get(row.key) ?? { loss: 0, count: 0 };
    current.loss += Math.abs(row.pnl);
    current.count += 1;
    grouped.set(row.key, current);
  }
  return [...grouped.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((left, right) => right.loss - left.loss || right.count - left.count);
}

function finding(
  key: string,
  title: string,
  value: string,
  detail: string,
  severity: BacktestLossFinding['severity'],
): BacktestLossFinding {
  return { key, title, value, detail, severity };
}

export function analyzeBacktestLoss(result: BacktestResult): BacktestLossAttribution {
  const losingTrades = result.trades.filter((trade) => trade.netPnl < 0);
  const grossLosingPnl = sum(losingTrades.map((trade) => Math.abs(trade.netPnl)));
  const totalModeledCosts = Math.max(0, result.totalFees) + Math.max(0, result.totalSlippage) + Math.max(0, result.totalFunding);
  const findings: BacktestLossFinding[] = [];

  const sideLosses = groupLoss(losingTrades.map((trade) => ({ key: trade.side, pnl: trade.netPnl })));
  const worstSide = sideLosses[0]?.key ?? null;
  if (worstSide && grossLosingPnl > 0) {
    const row = sideLosses[0];
    const share = row.loss / grossLosingPnl * 100;
    findings.push(finding(
      'side',
      '방향별 손실 집중',
      `${worstSide === 'long' ? '롱' : '숏'} ${number.format(share)}%`,
      `손실 거래의 절대 손실액 기준으로 ${row.count}건이 가장 큰 비중을 차지했습니다. 방향 자체의 인과를 뜻하지는 않습니다.`,
      share >= 60 ? 'high' : 'medium',
    ));
  }

  const regimeLosses = groupLoss(losingTrades.map((trade) => ({ key: trade.marketRegime || 'unknown', pnl: trade.netPnl })));
  const worstRegime = regimeLosses[0]?.key ?? null;
  if (worstRegime && grossLosingPnl > 0) {
    const row = regimeLosses[0];
    const share = row.loss / grossLosingPnl * 100;
    findings.push(finding(
      'regime',
      '시장 국면별 손실 집중',
      `${worstRegime} ${number.format(share)}%`,
      `해당 국면에서 ${row.count}건의 손실 거래가 관찰됐습니다. Regime 필터 후보를 검증할 때 우선 확인할 구간입니다.`,
      share >= 50 ? 'high' : 'medium',
    ));
  }

  const exitLosses = groupLoss(losingTrades.map((trade) => ({ key: trade.exitReason || 'unknown', pnl: trade.netPnl })));
  const worstExitReason = exitLosses[0]?.key ?? null;
  if (worstExitReason && grossLosingPnl > 0) {
    const row = exitLosses[0];
    findings.push(finding(
      'exit',
      '종료 사유별 손실',
      `${worstExitReason} · ${row.count}건`,
      `이 종료 사유의 절대 손실액은 ${money(row.loss)}입니다. 손절 폭·신호 종료·보유시간 조건을 따로 비교할 근거입니다.`,
      row.count >= Math.max(3, losingTrades.length * 0.5) ? 'high' : 'medium',
    ));
  }

  const negativeMonths = result.monthlyPerformance.filter((row) => row.netPnl < 0);
  const worstMonthRow = [...negativeMonths].sort((a, b) => a.netPnl - b.netPnl)[0] ?? null;
  const worstMonth = worstMonthRow?.month ?? null;
  if (worstMonthRow) {
    findings.push(finding(
      'month',
      '기간 편중',
      `${worstMonthRow.month} ${money(worstMonthRow.netPnl)}`,
      `음수 월은 ${negativeMonths.length}/${result.monthlyPerformance.length}개입니다. 특정 기간 한 번의 충격인지 반복되는 약점인지 분리해서 봐야 합니다.`,
      negativeMonths.length >= Math.ceil(result.monthlyPerformance.length / 2) ? 'high' : 'medium',
    ));
  }

  const training = result.validationPerformance.find((row) => row.name === 'training') ?? null;
  const validation = result.validationPerformance.find((row) => row.name === 'validation') ?? null;
  const test = result.validationPerformance.find((row) => row.name === 'test') ?? null;
  const validationWeakness = Boolean(
    training && training.netPnl > 0
    && ((validation && validation.netPnl <= 0) || (test && test.netPnl <= 0)),
  );
  if (validationWeakness) {
    findings.push(finding(
      'validation',
      '검증 구간 약화',
      'TRAIN 양수 → 검증/테스트 약화',
      '학습 구간에서만 좋아지고 이후 구간에서 약해졌습니다. 파라미터 과적합 가능성을 우선 점검해야 합니다.',
      'high',
    ));
  }

  if (totalModeledCosts > 0) {
    const costRows = [
      { label: '수수료', value: Math.max(0, result.totalFees) },
      { label: '슬리피지', value: Math.max(0, result.totalSlippage) },
      { label: '펀딩비', value: Math.max(0, result.totalFunding) },
    ].sort((a, b) => b.value - a.value);
    findings.push(finding(
      'cost',
      '모델링 비용',
      `총 ${money(totalModeledCosts)} · 최대 ${costRows[0].label}`,
      `${costRows.map((row) => `${row.label} ${money(row.value)}`).join(' · ')}. 비용 전 성과와 동일하다고 가정하지 않습니다.`,
      totalModeledCosts > Math.abs(result.finalCapital - result.initialCapital) ? 'high' : 'info',
    ));
  }

  if (!findings.length) {
    findings.push(finding(
      'insufficient',
      '손실 집중 근거 부족',
      '뚜렷한 단일 요인 없음',
      '현재 결과에서 한 방향·국면·종료 사유로 손실이 뚜렷하게 집중되지 않았습니다. 거래별 원장을 함께 확인하세요.',
      'info',
    ));
  }

  return {
    status: result.totalReturnPercent < 0 ? 'LOSS' : result.totalReturnPercent > 0 ? 'PROFIT' : 'FLAT',
    findings,
    losingTradeCount: losingTrades.length,
    grossLosingPnl,
    totalModeledCosts,
    worstSide,
    worstRegime,
    worstExitReason,
    worstMonth,
    validationWeakness,
    deterministic: true,
    externalAiCalled: false,
  };
}
