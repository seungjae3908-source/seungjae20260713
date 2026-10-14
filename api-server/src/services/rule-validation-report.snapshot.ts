// Hand-recorded snapshot of the rule-validation runs done on 2026-10-14/15.
// Only figures that were actually read from the run output are recorded here;
// anything not read is left out and said so in the note. This is research
// evidence, not a trading signal: executionAuthority stays NONE.
import { RULE_VALIDATION_SCHEMA, type RuleValidationReport } from './rule-validation-report.service';

const FIVE_MINUTE_COST = '수수료 0.05%+슬리피지 0.05% (편도) · 왕복 0.2% · 최대 보유 4시간';

export const RULE_VALIDATION_SNAPSHOT: RuleValidationReport = {
  schemaVersion: RULE_VALIDATION_SCHEMA,
  generatedAt: '2026-10-15T05:30:00+09:00',
  executionAuthority: 'NONE',
  profitabilityProven: false,
  passedRuleCount: 0,
  summary: '비용(수수료·슬리피지)을 뺀 뒤에도 학습·검증·테스트 구간을 모두 통과한 규칙은 아직 없습니다.',
  studies: [
    {
      id: 'upbit-spot-5m-top30-20261014',
      label: '업비트 현물 5분봉 단타 규칙 비교',
      market: 'CRYPTO_SPOT',
      timeframe: '5분봉',
      periodLabel: '최근 약 30일 (앞 2/3 학습, 뒤 1/3 검증)',
      symbolsLabel: 'KRW 마켓 거래대금 상위 30개',
      costLabel: FIVE_MINUTE_COST,
      status: 'WATCH',
      note: '규칙 B는 검증 표본이 27건으로 기준(30건)에 못 미쳐 판정 보류입니다. 학습구간 하한이 마이너스이고 12가지 조합 중 하나라 우연일 가능성이 큽니다. 규칙 C의 나머지 조합과 기준선 수치는 기록하지 않았습니다.',
      rows: [
        {
          ruleLabel: 'A 거래량 돌파', barrierLabel: '손절 1% / 익절 2%',
          train: { n: 842, winRate: 0.35, expectancyPercent: -0.152, lowerBoundPercent: -0.197 },
          validation: { n: 359, winRate: 0.30, expectancyPercent: -0.236, lowerBoundPercent: -0.303 },
          test: null, verdict: 'fail',
        },
        {
          ruleLabel: 'A 거래량 돌파', barrierLabel: '손절 1.5% / 익절 3%',
          train: { n: 842, winRate: 0.38, expectancyPercent: -0.123, lowerBoundPercent: -0.185 },
          validation: { n: 357, winRate: 0.30, expectancyPercent: -0.266, lowerBoundPercent: -0.357 },
          test: null, verdict: 'fail',
        },
        {
          ruleLabel: 'A 거래량 돌파', barrierLabel: '손절 2% / 익절 4%',
          train: { n: 842, winRate: 0.40, expectancyPercent: -0.066, lowerBoundPercent: -0.140 },
          validation: { n: 353, winRate: 0.31, expectancyPercent: -0.295, lowerBoundPercent: -0.405 },
          test: null, verdict: 'fail',
        },
        {
          ruleLabel: 'B 상승추세 눌림', barrierLabel: '손절 1% / 익절 2%',
          train: { n: 65, winRate: 0.43, expectancyPercent: 0.053, lowerBoundPercent: -0.110 },
          validation: { n: 27, winRate: 0.63, expectancyPercent: 0.536, lowerBoundPercent: 0.282 },
          test: null, verdict: 'insufficient_samples',
        },
        {
          ruleLabel: 'B 상승추세 눌림', barrierLabel: '손절 1.5% / 익절 3%',
          train: { n: 65, winRate: 0.48, expectancyPercent: 0.143, lowerBoundPercent: -0.056 },
          validation: { n: 27, winRate: 0.63, expectancyPercent: 0.848, lowerBoundPercent: 0.491 },
          test: null, verdict: 'insufficient_samples',
        },
        {
          ruleLabel: 'B 상승추세 눌림', barrierLabel: '손절 2% / 익절 4%',
          train: { n: 65, winRate: 0.51, expectancyPercent: 0.162, lowerBoundPercent: -0.058 },
          validation: { n: 27, winRate: 0.63, expectancyPercent: 1.122, lowerBoundPercent: 0.680 },
          test: null, verdict: 'insufficient_samples',
        },
        {
          ruleLabel: 'C 모멘텀 지속', barrierLabel: '손절 1% / 익절 2%',
          train: { n: 716, winRate: 0.34, expectancyPercent: -0.206, lowerBoundPercent: -0.258 },
          validation: { n: 294, winRate: 0.33, expectancyPercent: -0.180, lowerBoundPercent: -0.261 },
          test: null, verdict: 'fail',
        },
      ],
    },
    {
      id: 'upbit-spot-15m-1h-20261014',
      label: '업비트 현물 15분봉·1시간봉 규칙 비교',
      market: 'CRYPTO_SPOT',
      timeframe: '15분봉 · 1시간봉',
      periodLabel: '최근 약 30일',
      symbolsLabel: 'KRW 마켓 거래대금 상위 30개',
      costLabel: FIVE_MINUTE_COST,
      status: 'FAIL',
      note: '서버 실행 요약 기준으로 12개 규칙·손절익절 조합이 모두 불합격했습니다. 세부 수치는 이 화면에 기록하지 않았습니다.',
      rows: [],
    },
    {
      id: 'upbit-spot-4h-btc-eth-pnl-suite',
      label: '업비트 현물 4시간봉 돌파 규칙 (기존 연구 도구)',
      market: 'CRYPTO_SPOT',
      timeframe: '4시간봉',
      periodLabel: '2024-10-14 ~ 2026-10-14 (2년)',
      symbolsLabel: 'BTC, ETH',
      costLabel: '편도 0.15% · 테스트 구간은 비용 1.5배로 재확인',
      status: 'FAIL',
      note: '검증 구간에서 기대수익이 마이너스로 나와 후보가 되지 못했습니다(research_hold). 테스트 구간은 16건이라 우연과 구분하기 어렵습니다.',
      rows: [
        {
          ruleLabel: '48봉 돌파 + 이동평균 24 + 상대거래량 1배 이상',
          barrierLabel: 'ATR 2.5배 손절 / 손익비 2 / 최대 12봉',
          train: { n: 78, winRate: 0.538, expectancyPercent: 0.62, maxDrawdownPercent: 21.6 },
          validation: { n: 20, winRate: 0.45, expectancyPercent: -0.27, maxDrawdownPercent: 15.7 },
          test: { n: 16, winRate: 0.5, expectancyPercent: 1.13, maxDrawdownPercent: 6.7 },
          stressTest: { n: 16, winRate: 0.438, expectancyPercent: 0.98, maxDrawdownPercent: 7.2 },
          verdict: 'fail',
        },
      ],
    },
  ],
};
