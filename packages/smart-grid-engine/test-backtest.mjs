import { runBacktest } from './src/backtest-engine.mjs';
runBacktest({ symbol: 'BTCUSDT', gridCount: 10, investmentUsdt: 300, leverage: 5 });
