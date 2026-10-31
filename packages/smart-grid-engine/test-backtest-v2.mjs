import { runBacktest } from './src/backtest-engine.mjs';
runBacktest({ symbol: 'BTCUSDT', gridCount: 10, investmentUsdt: 300, leverage: 5, days: 180, interval: '4H' })
  .then(r => {
    console.log('\n=== 원본 거래 기록 (최근 5건) ===');
    console.log(JSON.stringify(r.trades.slice(-5), null, 2));
  })
  .catch(e => { console.error('FAILED:', e.message); process.exit(1); });
