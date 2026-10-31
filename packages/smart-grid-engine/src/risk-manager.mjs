import { fetchKrwUsdtRate } from './bitget-adapter.mjs';

// C-7: Private API 미활성 - 안전 실패
export async function fetchAccountBalance(_credentials) {
  throw new Error('PRIVATE_API_NOT_ACTIVATED: 실 잔액 조회 불가 - 500,000원 한도는 실 잔액 없이 검증 불가');
}

// C-8: 실시간 환율 기반 위험 검사
export async function checkRiskLimitsWithLiveRate({ totalInvestmentUsdt, maxLimitKrw = 500000, currentPrice, lowerPrice, leverage, feeRate = 0.0006 }) {
  const fx = await fetchKrwUsdtRate();
  const investKrw = totalInvestmentUsdt * fx.rate;
  const feesKrw = totalInvestmentUsdt * feeRate * 2 * fx.rate;
  if (investKrw + feesKrw > maxLimitKrw) {
    return { approved: false, reason: `EXCEEDS_KRW_LIMIT: ${investKrw.toFixed(0)}+${feesKrw.toFixed(0)} > ${maxLimitKrw}`, fx };
  }
  const maint = 0.005;
  const liqPrice = currentPrice * (1 - (1 / leverage) + maint);
  if (liqPrice >= lowerPrice) {
    return { approved: false, reason: `LIQUIDATION_INSIDE_GRID: liq=${liqPrice.toFixed(2)} >= lower=${lowerPrice.toFixed(2)}`, fx, liquidationPrice: liqPrice };
  }
  return { approved: true, fx, liquidationPrice: liqPrice, investmentKrw: Math.round(investKrw), feesKrw: Math.round(feesKrw), liquidationDistance: ((currentPrice - liqPrice) / currentPrice * 100).toFixed(2) + '%' };
}

// 기존 호환 (deprecated, 백테스트/테스트 파일용)
export function checkRiskLimits({ totalInvestmentUsdt, exchangeRateKrw = 1350, maxLimitKrw = 500000, currentPrice, lowerPrice, leverage }) {
  const investKrw = totalInvestmentUsdt * exchangeRateKrw;
  if (investKrw > maxLimitKrw) return { approved: false, reason: `EXCEEDS_KRW_LIMIT: ${investKrw.toFixed(0)} > ${maxLimitKrw}` };
  const maint = 0.005;
  const liqPrice = currentPrice * (1 - (1 / leverage) + maint);
  if (liqPrice >= lowerPrice) return { approved: false, reason: `LIQUIDATION_RISK`, liquidationPrice: liqPrice };
  return { approved: true, liquidationPrice: liqPrice, investmentKrw: investKrw };
}

export function selectStrategy({ rsi, macdHistogram, adx, currentPrice, atr }) {
  let direction = 'NEUTRAL', gridMode = 'arithmetic';
  if (adx > 25) { direction = rsi > 50 ? 'LONG' : 'SHORT'; gridMode = 'geometric'; }
  return { direction, gridMode, confidence: adx > 25 ? 'HIGH' : 'MEDIUM', reason: `ADX=${adx.toFixed(1)}, RSI=${rsi.toFixed(1)}` };
}
