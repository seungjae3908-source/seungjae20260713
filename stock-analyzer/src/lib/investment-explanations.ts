export type InvestmentExplanationKey =
  | 'tradingValue'
  | 'volume'
  | 'marketCap'
  | 'fundingRate'
  | 'openInterest'
  | 'macroF1'
  | 'balancedAccuracy'
  | 'sampleN'
  | 'profitFactor'
  | 'expectancy'
  | 'maxDrawdown'
  | 'winRate'
  | 'holdout'
  | 'shadow'
  | 'naturalPaper'
  | 'settlement'
  | 'profitability'
  | 'strategyHealth'
  | 'promotion'
  | 'concentration'
  | 'correlation'
  | 'dataQuality'
  | 'aiConfidence'
  | 'evidenceCoverage'
  | 'freshness'
  | 'targetPrice'
  | 'stopLoss';

export type InvestmentExplanation = {
  label: string;
  oneLine: string;
  whyItMatters: string;
  caution: string;
  related: string[];
  direction?: 'higher-usually-better' | 'lower-usually-better' | 'context-dependent';
};

export const INVESTMENT_EXPLANATIONS: Record<InvestmentExplanationKey, InvestmentExplanation> = {
  tradingValue: {
    label: '거래대금',
    oneLine: '실제로 얼마나 많은 돈이 이 자산에 거래되고 있는지 보여주는 값입니다.',
    whyItMatters: '거래 관심과 유동성을 확인하는 데 도움이 됩니다. 같은 등락률이어도 거래대금이 크면 시장 참여가 더 강할 수 있습니다.',
    caution: '거래대금이 크다고 상승을 의미하지는 않습니다. 가격 방향, 거래량 변화, 뉴스·공시와 함께 봐야 합니다.',
    related: ['거래량', '등락률', '뉴스·공시', '시장 평균'],
    direction: 'context-dependent',
  },
  volume: {
    label: '거래량',
    oneLine: '일정 기간 동안 실제로 거래된 수량입니다.',
    whyItMatters: '가격 움직임에 얼마나 많은 참여가 붙었는지 확인할 수 있습니다.',
    caution: '절대 거래량보다 평소 대비 변화와 가격 방향을 같이 보는 것이 중요합니다.',
    related: ['거래대금', '가격 변화', '평균 거래량'],
    direction: 'context-dependent',
  },
  marketCap: {
    label: '시가총액',
    oneLine: '현재 가격을 기준으로 본 기업 또는 자산의 시장가치 규모입니다.',
    whyItMatters: '유동성·변동성·시장 영향력을 이해하는 기본 규모 지표입니다.',
    caution: '시가총액이 크거나 작다는 사실만으로 저평가·고평가를 판단할 수 없습니다.',
    related: ['거래대금', '재무', '밸류에이션'],
    direction: 'context-dependent',
  },
  fundingRate: {
    label: '펀딩비',
    oneLine: '코인 무기한 선물에서 롱·숏 포지션 사이에 주기적으로 교환되는 비용 지표입니다.',
    whyItMatters: '시장 포지션 쏠림과 선물 보유 비용을 파악하는 보조 근거가 됩니다.',
    caution: '양수·음수 자체가 즉시 반전 또는 추세 지속을 뜻하지 않습니다.',
    related: ['미결제약정', '현물-선물 가격차', '청산', '가격 추세'],
    direction: 'context-dependent',
  },
  openInterest: {
    label: '미결제약정',
    oneLine: '아직 청산되지 않은 선물 계약의 규모입니다.',
    whyItMatters: '새로운 레버리지 포지션이 시장에 쌓이는지 줄어드는지 보는 데 도움이 됩니다.',
    caution: '증가만으로 롱 또는 숏 방향을 확정할 수 없습니다.',
    related: ['펀딩비', '가격 변화', '거래량', '청산'],
    direction: 'context-dependent',
  },
  macroF1: {
    label: 'Macro F1',
    oneLine: '여러 결과 클래스를 한쪽에 치우치지 않게 얼마나 고르게 맞혔는지 보는 점수입니다.',
    whyItMatters: '상승만 많이 찍어서 정확도가 높아 보이는 식의 착시를 줄이는 데 도움이 됩니다.',
    caution: '점수 하나로 실전 수익성을 증명할 수 없습니다. 표본수·Holdout·비용조정 결과를 같이 봐야 합니다.',
    related: ['Balanced Accuracy', '표본 N', '클래스별 Recall', 'Holdout'],
    direction: 'higher-usually-better',
  },
  balancedAccuracy: {
    label: 'Balanced Accuracy',
    oneLine: '각 결과 클래스를 동일하게 중요하게 보고 계산한 균형 정확도입니다.',
    whyItMatters: '데이터가 특정 방향에 몰려 있을 때 일반 Accuracy가 주는 착시를 줄입니다.',
    caution: '표본이 작거나 클래스 자체가 불안정하면 높은 숫자도 과신하면 안 됩니다.',
    related: ['Macro F1', '표본 N', '클래스별 Recall', 'Collapse'],
    direction: 'higher-usually-better',
  },
  sampleN: {
    label: '표본 N',
    oneLine: '현재 평가에 실제로 사용된 독립적인 사례 수입니다.',
    whyItMatters: '성과 숫자가 우연인지 반복 가능한지 판단하려면 충분한 표본이 필요합니다.',
    caution: '표본이 많다는 것만으로 품질이 보장되지는 않으며 중복·누수·편향 여부도 확인해야 합니다.',
    related: ['Holdout', 'Walk-Forward', '승률', 'EV'],
    direction: 'context-dependent',
  },
  profitFactor: {
    label: 'Profit Factor',
    oneLine: '총이익을 총손실로 나눈 값으로 이익과 손실의 크기 균형을 보는 지표입니다.',
    whyItMatters: '승률만으로 보이지 않는 손익 구조를 확인할 수 있습니다.',
    caution: '거래 수가 적거나 큰 한두 번의 이익에 의존하면 왜곡될 수 있습니다.',
    related: ['EV', '승률', 'MDD', '거래 수'],
    direction: 'higher-usually-better',
  },
  expectancy: {
    label: 'EV / 기대값',
    oneLine: '한 번의 거래를 반복했을 때 평균적으로 기대되는 손익을 나타내는 값입니다.',
    whyItMatters: '높은 승률이라도 손실이 너무 크면 전략이 나쁠 수 있어 수익성 판단의 핵심 근거가 됩니다.',
    caution: '수수료·슬리피지·펀딩비 등 실제 비용이 반영됐는지 반드시 확인해야 합니다.',
    related: ['Profit Factor', '승률', 'MDD', '비용조정'],
    direction: 'higher-usually-better',
  },
  maxDrawdown: {
    label: 'MDD',
    oneLine: '고점에서 저점까지 자산가치가 최대 얼마나 감소했는지 보여주는 위험 지표입니다.',
    whyItMatters: '수익률만으로 알 수 없는 실제 버티기 어려운 손실 구간을 보여줍니다.',
    caution: '과거 MDD보다 미래 손실이 더 커질 수 있습니다.',
    related: ['EV', 'Profit Factor', '변동성', 'Stress Test'],
    direction: 'lower-usually-better',
  },
  winRate: {
    label: '승률',
    oneLine: '전체 정산 거래 중 이익으로 끝난 비율입니다.',
    whyItMatters: '전략의 결과 분포를 이해하는 기본 지표입니다.',
    caution: '높은 승률만으로 수익 전략이라고 볼 수 없습니다. 평균 이익·평균 손실과 같이 봐야 합니다.',
    related: ['EV', 'Profit Factor', '평균 손익', '표본 N'],
    direction: 'higher-usually-better',
  },
  holdout: {
    label: 'Final Holdout',
    oneLine: '전략 개발 과정에서 보지 않은 마지막 데이터로 성능을 다시 확인하는 단계입니다.',
    whyItMatters: '개발 데이터에만 맞춘 과최적화를 잡아내는 마지막 독립 검증 장치입니다.',
    caution: 'Holdout을 여러 번 보고 전략을 다시 조정하면 더 이상 완전한 Holdout이 아닐 수 있습니다.',
    related: ['OOS', 'Purged Walk-Forward', '표본 N'],
    direction: 'context-dependent',
  },
  shadow: {
    label: 'Shadow',
    oneLine: '실제 주문 없이 현재 시장에서 신호가 어떻게 작동하는지 관찰하는 단계입니다.',
    whyItMatters: '백테스트와 실제 시계열 환경의 차이를 주문 위험 없이 확인할 수 있습니다.',
    caution: 'Shadow 성능은 실제 체결 비용과 계좌 제약을 완전히 재현하지 못할 수 있습니다.',
    related: ['Natural Paper', 'Settlement', 'Strategy Health'],
    direction: 'context-dependent',
  },
  naturalPaper: {
    label: 'Natural Paper',
    oneLine: '과거 재생이 아니라 실제 시간이 흐르는 동안 모의 포지션을 자연 발생 신호로 추적하는 단계입니다.',
    whyItMatters: '실시간 데이터 지연·신호 발생 순서·운영 환경을 포함한 검증에 도움이 됩니다.',
    caution: '표본이 0이거나 작으면 수익성을 결론낼 수 없습니다.',
    related: ['Shadow', 'Settlement', '표본 N', 'Profitability'],
    direction: 'context-dependent',
  },
  settlement: {
    label: 'Settlement',
    oneLine: '열린 모의 포지션이 실제 종료 조건을 만나 손익이 확정된 표본입니다.',
    whyItMatters: '진입 신호만이 아니라 완결된 거래 결과를 기준으로 평가할 수 있습니다.',
    caution: '정산 N이 부족하면 EV·PF·승률 같은 수익성 숫자는 신뢰하기 어렵습니다.',
    related: ['Natural Paper', 'EV', 'Profit Factor', '표본 N'],
    direction: 'context-dependent',
  },
  profitability: {
    label: '수익성 증거',
    oneLine: '정산된 실제 모의 표본을 이용해 비용까지 고려한 수익성이 확인됐는지 보는 단계입니다.',
    whyItMatters: '정확도와 실제 돈의 손익은 다르므로 별도 검증이 필요합니다.',
    caution: '증거가 부족할 때 PASS나 0으로 간주하지 말고 미수집 상태를 유지해야 합니다.',
    related: ['EV', 'Profit Factor', 'MDD', 'Settlement'],
    direction: 'context-dependent',
  },
  strategyHealth: {
    label: 'Strategy Health',
    oneLine: '최근 전략 성능이 과거 검증 범위에서 유지되는지 지속적으로 확인하는 상태입니다.',
    whyItMatters: '한때 좋았던 전략이 시장 변화로 망가지는 것을 조기에 감지할 수 있습니다.',
    caution: '단기 변동 한 번만으로 전략을 폐기하거나 승격하면 안 됩니다.',
    related: ['Drift', 'Shadow', 'Natural Paper', 'Promotion'],
    direction: 'context-dependent',
  },
  promotion: {
    label: 'Promotion',
    oneLine: '정해진 검증 조건을 모두 충족한 전략만 다음 단계 후보로 올리는 승격 절차입니다.',
    whyItMatters: '좋아 보이는 단일 결과가 검증 단계를 건너뛰지 못하게 합니다.',
    caution: 'Promotion은 실거래 허가와 동일하지 않습니다.',
    related: ['Holdout', 'Profitability', 'Strategy Health', 'Champion'],
    direction: 'context-dependent',
  },
  concentration: {
    label: '집중도',
    oneLine: '포트폴리오의 큰 보유종목 몇 개가 전체 자산에서 차지하는 비중입니다.',
    whyItMatters: '특정 종목이나 테마 충격이 전체 자산에 미치는 영향을 파악할 수 있습니다.',
    caution: '적정 집중도는 투자목표와 자산 특성에 따라 달라 고정 임계값을 임의로 적용하면 안 됩니다.',
    related: ['자산배분', '상관관계', 'Stress Test'],
    direction: 'context-dependent',
  },
  correlation: {
    label: '상관관계',
    oneLine: '두 자산의 수익률이 같은 방향으로 움직이는 정도를 나타냅니다.',
    whyItMatters: '종목 수가 많아도 서로 같이 움직이면 실제 분산효과가 작을 수 있습니다.',
    caution: '상관관계는 기간과 시장 국면에 따라 빠르게 변할 수 있습니다.',
    related: ['집중도', '자산배분', 'Stress Test', '표본 N'],
    direction: 'context-dependent',
  },
  dataQuality: {
    label: '데이터 품질',
    oneLine: '분석에 필요한 원본 데이터가 얼마나 완전하고 유효하게 수집됐는지 나타냅니다.',
    whyItMatters: '분석 모델보다 입력 데이터가 부족하면 결론의 신뢰성이 먼저 떨어집니다.',
    caution: 'PARTIAL 또는 UNAVAILABLE을 0으로 바꾸어 계산하면 안 됩니다.',
    related: ['출처', 'Freshness', 'Missing Evidence', 'Evidence Coverage'],
    direction: 'context-dependent',
  },
  aiConfidence: {
    label: 'AI 신뢰도',
    oneLine: 'AI 모델이 자신의 현재 판단에 부여한 확신도이며 실제 적중확률과는 다릅니다.',
    whyItMatters: '모델이 애매한 상황인지 강하게 판단하는 상황인지 비교하는 보조값으로 쓸 수 있습니다.',
    caution: '과거 Calibration·표본·Evidence Coverage 없이 이 숫자만 투자 확률로 해석하면 안 됩니다.',
    related: ['Evidence Coverage', '과거 Calibration', '데이터 품질', '반대 근거'],
    direction: 'context-dependent',
  },
  evidenceCoverage: {
    label: 'Evidence Coverage',
    oneLine: '현재 판단에 필요한 근거 중 실제로 확보된 근거의 범위를 보여줍니다.',
    whyItMatters: 'AI 자신감과 별개로 입력 근거가 충분한지 확인할 수 있습니다.',
    caution: 'Coverage가 높아도 근거 자체가 오래됐거나 편향되면 결론은 약할 수 있습니다.',
    related: ['데이터 품질', 'Freshness', 'Missing Evidence'],
    direction: 'higher-usually-better',
  },
  freshness: {
    label: '데이터 신선도',
    oneLine: '현재 분석이 얼마나 최근에 수집된 데이터에 기반하는지 나타냅니다.',
    whyItMatters: '가격·뉴스·공시처럼 빠르게 변하는 데이터는 오래될수록 현재 의사결정 가치가 떨어집니다.',
    caution: '시장별 거래시간과 공급자 지연을 같이 확인해야 합니다.',
    related: ['수집 시각', 'Provider', 'Stale 상태', '데이터 품질'],
    direction: 'context-dependent',
  },
  targetPrice: {
    label: '목표가',
    oneLine: '특정 분석 근거가 유지될 때 기대 시나리오에서 확인하는 가격 기준입니다.',
    whyItMatters: '진입 전 기대 보상과 위험의 비율을 비교하는 데 사용할 수 있습니다.',
    caution: '근거가 없거나 무효화 조건이 정의되지 않았다면 현재가의 임의 퍼센트로 목표가를 만들어서는 안 됩니다.',
    related: ['진입 근거', '손절', '무효화 조건', 'Risk/Reward'],
    direction: 'context-dependent',
  },
  stopLoss: {
    label: '손절 기준',
    oneLine: '현재 투자 가설이 무효화됐다고 판단할 가격 또는 조건 기준입니다.',
    whyItMatters: '예상과 반대로 움직였을 때 손실이 통제 없이 커지는 것을 막는 계획 근거입니다.',
    caution: '단순 현재가 대비 고정 퍼센트를 분석 근거처럼 표시하면 안 됩니다.',
    related: ['무효화 조건', '목표가', '변동성', '지지·저항'],
    direction: 'context-dependent',
  },
};

export function getInvestmentExplanation(key: InvestmentExplanationKey): InvestmentExplanation {
  return INVESTMENT_EXPLANATIONS[key];
}

export function describeMetricChange(
  key: InvestmentExplanationKey,
  current: number | null | undefined,
  previous: number | null | undefined,
): string | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const delta = current - previous;
  if (Math.abs(delta) < Number.EPSILON) return '이전 측정값과 같습니다.';
  const definition = INVESTMENT_EXPLANATIONS[key];
  const direction = delta > 0 ? '증가' : '감소';
  if (definition.direction === 'context-dependent') return `이전보다 ${direction}했습니다. 이 지표는 방향만으로 좋고 나쁨을 판정하지 않습니다.`;
  const improved = definition.direction === 'higher-usually-better' ? delta > 0 : delta < 0;
  return `이전보다 ${direction}했습니다. 일반적으로는 ${improved ? '유리한' : '불리한'} 방향이지만 표본과 다른 근거를 함께 확인해야 합니다.`;
}
