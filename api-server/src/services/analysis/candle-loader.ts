// 3차 작업 공용 캔들 로더.
// chart-signals / ai-chart-plan 서비스가 공유한다.
// 호출부가 asset/coinMarket 인자를 누락하거나 코인 심볼만 넘겨도
// 실제 데이터를 안정적으로 찾도록 방어 로직을 포함한다. (가짜 데이터 생성 금지)

import { toBars, type Bar } from './candle-math';
import { MarketDataService } from '../market-data.service';
import { fetchUpbitCandles, fetchBitgetCandles } from './crypto-source';

// 업비트(KRW 마켓)에 상장된 대표 코인 심볼. 코인 자동 판별용 최소 목록.
const COIN_HINT = new Set([
  'BTC', 'ETH', 'XRP', 'SOL', 'ADA', 'DOGE', 'AVAX', 'DOT', 'TRX', 'LINK',
  'MATIC', 'BCH', 'LTC', 'ATOM', 'ETC', 'XLM', 'NEAR', 'APT', 'ARB', 'OP',
  'SUI', 'SEI', 'TIA', 'INJ', 'SHIB', 'PEPE', 'UNI', 'AAVE', 'SAND', 'MANA',
]);

function looksLikeCoin(symbol: string): boolean {
  const s = symbol.toUpperCase();
  if (COIN_HINT.has(s.replace(/^KRW-/, '').replace(/USDT$/, ''))) return true;
  if (/USDT$/.test(s)) return true; // bitget 선물 심볼 형태
  if (/^KRW-/.test(s)) return true;
  return false;
}

function hasEnoughBars(rows: Bar[], interval: string): boolean {
  const minimum = /^(?:3D|5D|15D|1M|3M|6M|1Y|3Y|5Y|10Y|ALL)$/i.test(interval)
    ? 2
    : 30;
  return rows.length >= minimum;
}

async function loadUpbit(symbol: string, interval: string): Promise<Bar[]> {
  const tf =
    interval === '1H'
      ? '60m'
      : interval === '4H'
        ? '240m'
        : interval && /^[0-9]/.test(interval)
          ? interval
          : interval || '1D';
  return fetchUpbitCandles(symbol.toUpperCase().replace(/^KRW-/, ''), 200, tf);
}

async function loadBitget(symbol: string, interval: string): Promise<Bar[]> {
  const gran = interval && /^[0-9]/.test(interval) ? interval : '1D';
  let sym = symbol.toUpperCase();
  if (!/USDT$/.test(sym)) sym = `${sym}USDT`;
  return fetchBitgetCandles(sym, 200, gran);
}

async function loadStock(symbol: string, interval: string): Promise<Bar[]> {
  if (!symbol) return [];
  const candles = await MarketDataService.getCandles(symbol, (interval || '1D') as any);
  return toBars(candles as Bar[]);
}

export interface LoadBarsOptions {
  // 비트겟(선물) 소스 사용 허용 여부. 보안: 정회원(requireFullMember) 통과 요청만 true.
  // false 이면 어떤 경로에서도 선물 캔들을 조회/폴백하지 않는다.
  allowFutures?: boolean;
}

/**
 * asset/coinMarket/symbol/interval 을 받아 실제 캔들 Bar[] 를 반환한다.
 * - asset==='coin'  → coinMarket 에 따라 업비트(spot)/비트겟(futures) 조회
 * - asset==='stock' → MarketDataService 조회
 * 방어: 인자 순서 오류 등으로 asset 값이 코인 심볼처럼 들어오거나,
 *       stock 경로에서 데이터가 없고 심볼이 코인으로 보이면 코인 소스로 폴백.
 *
 * 보안: 선물(비트겟) 소스는 options.allowFutures === true 일 때만 사용한다.
 *       coinMarket=futures 명시 요청도 allowFutures=false 이면 선물 조회를 하지 않는다
 *       (라우트에서 정회원 미통과 시 이미 403 이지만 방어적 이중 차단).
 */
export async function loadBars(
  asset: string,
  coinMarket: string,
  symbol: string,
  interval: string,
  options: LoadBarsOptions = {},
): Promise<Bar[]> {
  const allowFutures = options.allowFutures === true;
  const assetNorm = String(asset ?? '').toLowerCase();
  const cm = String(coinMarket ?? 'spot').toLowerCase();
  let sym = String(symbol ?? '').trim();

  // 방어: 인자 순서 오류로 심볼이 비고 asset 자리에 코인/종목 심볼이 들어온 경우 보정.
  // 예) 잘못된 호출 loadBars('BTC','1D') → asset='BTC', symbol='' 로 들어옴.
  if (!sym && asset && !['stock', 'coin'].includes(assetNorm)) {
    sym = String(asset).trim();
  }

  if (assetNorm === 'coin') {
    if (cm === 'futures') {
      // 선물 요청: 정회원 미통과(allowFutures=false)면 선물 소스 자체를 시도하지 않는다.
      if (!allowFutures) return [];
      try {
        const bars = await loadBitget(sym, interval);
        if (hasEnoughBars(bars, interval)) return bars;
      } catch {
        /* 무시 */
      }
      return [];
    }
    // 현물 요청: 업비트 우선, 실패 시 선물 폴백은 allowFutures 인 경우에만.
    try {
      const bars = await loadUpbit(sym, interval);
      if (hasEnoughBars(bars, interval)) return bars;
    } catch {
      /* 아래 폴백으로 진행 */
    }
    if (allowFutures) {
      try {
        const alt = await loadBitget(sym, interval);
        if (hasEnoughBars(alt, interval)) return alt;
      } catch {
        /* 무시 */
      }
    }
    return [];
  }

  // stock 경로. 단, 심볼이 명확히 코인으로 보이면 코인 소스를 먼저 시도한다
  // (asset 인자 누락/오류로 코인 심볼이 stock 경로로 들어온 경우 방어).
  // 이때도 선물(비트겟) 폴백은 allowFutures 인 경우에만 허용한다.
  if (looksLikeCoin(sym)) {
    try {
      const up = await loadUpbit(sym, interval);
      if (hasEnoughBars(up, interval)) return up;
    } catch {
      /* 무시 */
    }
    if (allowFutures) {
      try {
        const bg = await loadBitget(sym, interval);
        if (hasEnoughBars(bg, interval)) return bg;
      } catch {
        /* 무시 */
      }
    }
  }

  let bars: Bar[] = [];
  try {
    bars = await loadStock(sym, interval);
  } catch {
    bars = [];
  }
  return bars;
}
