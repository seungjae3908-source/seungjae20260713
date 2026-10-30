import http from 'node:http';
import { fetchLiveOrderBook, getCurrentPrice } from './src/bitget-adapter.mjs';
import { selectStrategy, checkRiskLimits } from './src/risk-manager.mjs';
import { calculateGridLevels } from './src/grid-math.mjs';

const PORT = 8080;

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*'); // 프론트엔드 연동 허용

  if (req.url === '/api/dashboard' && req.method === 'GET') {
    try {
      const orderBook = await fetchLiveOrderBook('BTCUSDT');
      const currentPrice = getCurrentPrice(orderBook);
      
      const strategy = selectStrategy({ rsi: 45, macdHistogram: -0.1, adx: 15, currentPrice, atr: currentPrice * 0.02 });
      const levels = calculateGridLevels({ lowerPrice: currentPrice * 0.9, upperPrice: currentPrice * 1.1, gridCount: 10, mode: strategy.gridMode });
      
      const response = {
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        liveTradingEnabled: false, // LIVE 차단 상태 강제 표시
        marketData: {
          symbol: 'BTCUSDT',
          currentPrice,
          bestBid: orderBook.bids[0].price,
          bestAsk: orderBook.asks[0].price,
        },
        strategy: {
          direction: strategy.direction,
          mode: strategy.gridMode,
          reason: strategy.reason,
        },
        gridConfig: {
          lowerPrice: levels[0],
          upperPrice: levels[levels.length - 1],
          levels: levels,
        }
      };

      res.writeHead(200);
      res.end(JSON.stringify(response, null, 2));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'ERROR', message: error.message }));
    }
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Dashboard API Server running on http://localhost:${PORT}/api/dashboard`);
});
