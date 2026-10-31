import { calculateGridLevels, calculateGridQuantity, calculateDynamicBounds } from './src/grid-math.mjs';
import { checkRiskLimits, selectStrategy } from './src/risk-manager.mjs';

console.log('=== 스마트 그리드 시뮬레이션 시작 ===');

// 1. 시장 데이터 가정 (비트겟 BTC 현재가 60,000 USDT, 환율 1,350원)
const currentPrice = 60000;
const exchangeRate = 1350;
const atr = 1500; // 변동성 지표

// 2. AI 전략 선택
const strategy = selectStrategy({ rsi: 55, macdHistogram: 0.5, adx: 28, currentPrice, atr });
console.log('🤖 AI 선택 전략:', strategy);

// 3. 동적 가격 범위 계산 (ATR 기반)
const bounds = calculateDynamicBounds({ currentPrice, atr, multiplier: 3 });
console.log('📊 동적 범위:', bounds);

// 4. 그리드 레벨 계산 (10개)
const levels = calculateGridLevels({ lowerPrice: bounds.lowerPrice, upperPrice: bounds.upperPrice, gridCount: 10, mode: strategy.gridMode });
console.log('📏 그리드 가격 레벨(10개):', levels);

// 5. 리스크 검사 (총 50만 원 한도, 5배 레버리지)
const totalInvestmentUsdt = (500000 / exchangeRate) * 0.9; // 수수료 고려 90%만 사용
const riskCheck = checkRiskLimits({ 
  totalInvestmentUsdt, 
  exchangeRateKrw: exchangeRate, 
  currentPrice, 
  lowerPrice: bounds.lowerPrice, 
  leverage: 5 
});
console.log('🛡️ 리스크 통과 여부:', riskCheck);
