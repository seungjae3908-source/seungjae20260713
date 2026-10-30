import { calculateGridLevels, calculateGridQuantity } from './grid-math.mjs';

async function fetchHistoricalCandles(symbol, interval = '1H', limit = 1000) {
  // Bitget V3 캔들 API 스펙: granularity → interval, 응답은 배열의 배열
  const url = `https://api.bitget.com/api/v3/market/candles?category=USDT-FUTURES&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  const json = await res.json();

  if (json.code !== '00000' || !Array.isArray(json.data)) {
    throw new Error(`FAILED_TO_FETCH_CANDLES: code=${json.code}, msg=${json.msg}`);
  }

  // 각 캔들: [timestamp, open, high, low, close, volume, turnover]
  // 종가(close)만 추출하고, 시간순(과거→현재)으로 정렬
  return json.data.map((row) => Number(row[4])).reverse();
}

export async function runBacktest({ symbol = 'BTCUSDT', gridCount = 10, investmentUsdt = 300, leverage = 5 }) {
  console.log(`\n=== [백테스트 시작] ${symbol} (최근 1000시간) ===`);

  const closes = await fetchHistoricalCandles(symbol);
  const startPrice = closes[0];
  const lowerPrice = startPrice * 0.9;
  const upperPrice = startPrice * 1.1;

  const levels = calculateGridLevels({ lowerPrice, upperPrice, gridCount, mode: 'arithmetic' });
  const quantity = calculateGridQuantity({ totalInvestmentUsdt: investmentUsdt, gridCount, currentPrice: startPrice, leverage });

  console.log(`시작가: ${startPrice.toFixed(2)} | 범위: ${lowerPrice.toFixed(0)} ~ ${upperPrice.toFixed(0)} | 수량: ${quantity}`);

  let activeOrders = [];
  let completedTrades = 0;
  let totalProfitUsdt = 0;

  for (const level of levels) {
    if (level < startPrice) activeOrders.push({ type: 'BUY', price: level, status: 'PENDING' });
    else if (level > startPrice) activeOrders.push({ type: 'SELL', price: level, status: 'PENDING' });
  }

  for (let i = 0; i < closes.length; i++) {
    const price = closes[i];

    for (const order of activeOrders) {
      if (order.status !== 'PENDING') continue;

      if (order.type === 'BUY' && price <= order.price) {
        order.status = 'FILLED';
        totalProfitUsdt -= (order.price * quantity);
        const idx = levels.indexOf(order.price);
        if (idx + 1 < levels.length) activeOrders.push({ type: 'SELL', price: levels[idx + 1], status: 'PENDING' });
      } else if (order.type === 'SELL' && price >= order.price) {
        order.status = 'FILLED';
        totalProfitUsdt += (order.price * quantity);
        completedTrades++;
        const idx = levels.indexOf(order.price);
        if (idx - 1 >= 0) activeOrders.push({ type: 'BUY', price: levels[idx - 1], status: 'PENDING' });
      }
    }
  }

  const finalPrice = closes[closes.length - 1];
  const unrealizedPnl = activeOrders.filter(o => o.status === 'FILLED' && o.type === 'BUY').reduce((acc, o) => acc + ((finalPrice - o.price) * quantity), 0);

  console.log(`완료된 거래: ${completedTrades}회`);
  console.log(`실현 손익: ${totalProfitUsdt.toFixed(2)} USDT`);
  console.log(`미실현 손익: ${unrealizedPnl.toFixed(2)} USDT`);
  console.log(`최종 평가금: ${(totalProfitUsdt + unrealizedPnl).toFixed(2)} USDT`);
  console.log(`=== [백테스트 종료] ===\n`);

  return { completedTrades, totalProfitUsdt, unrealizedPnl, finalPrice };
}
