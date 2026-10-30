import http from 'node:http';
import { fetchLiveOrderBook, getCurrentPrice } from './src/bitget-adapter.mjs';
import { selectStrategy } from './src/risk-manager.mjs';
import { calculateGridLevels } from './src/grid-math.mjs';

// 기존 stock-app과 충돌하지 않도록 8099 포트 사용
const PORT = 8099;

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/dashboard' && req.method === 'GET') {
    try {
      const orderBook = await fetchLiveOrderBook('BTCUSDT');
      const currentPrice = getCurrentPrice(orderBook);
      
      const strategy = selectStrategy({ rsi: 45, macdHistogram: -0.1, adx: 15, currentPrice, atr: currentPrice * 0.02 });
      const levels = calculateGridLevels({ lowerPrice: currentPrice * 0.9, upperPrice: currentPrice * 1.1, gridCount: 10, mode: strategy.gridMode });
      
      const response = {
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
        liveTradingEnabled: false, // 🔒 LIVE 차단 상태 강제
        marketData: { symbol: 'BTCUSDT', currentPrice, bestBid: orderBook.bids[0].price, bestAsk: orderBook.asks[0].price },
        strategy: { direction: strategy.direction, mode: strategy.gridMode, reason: strategy.reason },
        gridConfig: { lowerPrice: levels[0], upperPrice: levels[levels.length - 1], levels: levels }
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

// 포트 충돌 등 서버 에러 핸들링
server.on('error', (err) => {
  console.error('SERVER_ERROR:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`🚀 Dashboard API Server running on http://localhost:${PORT}/api/dashboard`);
});
