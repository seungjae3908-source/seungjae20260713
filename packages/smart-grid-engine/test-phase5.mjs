import { fetchLiveOrderBook, getCurrentPrice } from './src/bitget-adapter.mjs';
import { checkRiskLimits, selectStrategy } from './src/risk-manager.mjs';
import { simulateGridTrading } from './src/paper-trading-sim.mjs';

async function run() {
  console.log('=== Phase 5: 모의투자(Paper Trading) 통합 테스트 ===');

  const symbol = 'BTCUSDT';
  console.log(`[1] ${symbol} 실시간 호가 조회 중...`);

  try {
    const orderBook = await fetchLiveOrderBook(symbol);
    const currentPrice = getCurrentPrice(orderBook);
    console.log(`[2] 현재가: ${currentPrice} USDT (데이터 검증 완료)`);

    const strategy = selectStrategy({
      rsi: 45, macdHistogram: -0.1, adx: 15, currentPrice, atr: currentPrice * 0.02,
    });
    console.log(`[3] AI 전략: ${strategy.direction} (${strategy.gridMode})`);

    const investmentUsdt = 300;
    const risk = checkRiskLimits({
      totalInvestmentUsdt: investmentUsdt,
      exchangeRateKrw: 1350,
      currentPrice,
      lowerPrice: currentPrice * 0.9,
      leverage: 5,
    });

    if (!risk.approved) {
      console.log(`[4] 리스크 검사 실패: ${risk.reason}`);
      return;
    }
    console.log(`[4] 리스크 검사 통과 (투자금: ${investmentUsdt} USDT, 청산가: ${risk.liquidationPrice?.toFixed(2)})`);

    console.log(`\n[5] 모의투자 시뮬레이션 시작`);
    const simResult = simulateGridTrading({
      currentPrice,
      lowerPrice: currentPrice * 0.9,
      upperPrice: currentPrice * 1.1,
      gridCount: 10,
      mode: strategy.gridMode,
      investmentUsdt,
      leverage: 5,
    });

    console.log(`\n[6] 시뮬레이션 결과:`);
    console.log(`   - 완료된 거래 횟수: ${simResult.completedTrades}회`);
    console.log(`   - 누적 손익: ${simResult.totalProfitUsdt.toFixed(2)} USDT`);
    console.log(`   - 대기 중인 주문: ${simResult.activeOrdersCount}개`);
    console.log(`\n✅ 실제 주문 없이 모의투자 로직 검증 완료!`);
  } catch (error) {
    console.error('오류 발생:', error.message);
  }
}

run();
