// 4차 작업 신규 라우터: 잔액 '조회' 전용 API.
// 주문/취소/정정/출금/자동매매 엔드포인트는 절대 호출하지 않는다 (GET 조회만).
// 기존 crypto-auto.ts(주문 코드 포함) 파일은 수정하지 않으며, 서명 로직은
// 이 파일 전용으로 GET 조회에 필요한 최소 형태만 재구현한다.

import { Router, type IRouter } from 'express';
import { createHmac } from 'node:crypto';
import { requireMember, requireFullMember } from '../middleware/auth';
import { kiwoomRequest, type KiwoomApiResponse } from '../providers/kiwoom';
import { MarketDataService } from '../services/market-data.service';

const router: IRouter = Router();

const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const BITGET_MARGIN_COIN = 'USDT';
const REQUEST_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 45_000; // 30~60초 캐시

// ---- 응답 타입 ----

interface KiwoomBalance {
  available: boolean;
  deposit: number | null;
  orderable: number | null;
  currency: 'KRW';
  error?: string;
}

interface BitgetSpotAsset {
  coin: string;
  amount: number;
  usdValue: number | null;
}

interface BitgetSpotBalance {
  available: boolean;
  assets: BitgetSpotAsset[];
  totalUsdt: number | null;
  error?: string;
}

interface BitgetFuturesBalance {
  available: boolean;
  availableUsdt: number | null;
  equityUsdt: number | null;
  error?: string;
}

interface BalancesResponse {
  ok: boolean;
  dataAsOf: string;
  fxKrwPerUsd: number | null;
  fxAsOf: string | null;
  kiwoom: KiwoomBalance;
  bitgetSpot: BitgetSpotBalance;
  bitgetFutures: BitgetFuturesBalance;
}

// ---- 유틸 ----

function finiteOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- 비트겟 GET 서명 요청 (조회 전용) ----

function bitgetHeaders(method: 'GET', requestPath: string, query = ''): Record<string, string> {
  const apiKey = String(process.env.BITGET_API_KEY ?? '').trim();
  const secret = String(process.env.BITGET_SECRET_KEY ?? '').trim();
  const passphrase = String(process.env.BITGET_PASSPHRASE ?? '').trim();
  if (!apiKey || !secret || !passphrase) throw new Error('BITGET_PRIVATE_KEYS_NOT_CONFIGURED');
  const timestamp = Date.now().toString();
  const queryPart = query ? `?${query}` : '';
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}${method}${requestPath}${queryPart}`)
    .digest('base64');
  return {
    'ACCESS-KEY': apiKey,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': passphrase,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    locale: 'en-US',
    'User-Agent': 'seungjae-investment-app/2.0',
  };
}

// 비트겟 GET 조회 요청. code !== '00000' 이면 실패로 간주한다.
async function bitgetGet<T>(requestPath: string, query = ''): Promise<T> {
  const url = `${BITGET_BASE}${requestPath}${query ? `?${query}` : ''}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: bitgetHeaders('GET', requestPath, query),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await response.text();
    let payload: { code?: string; msg?: string; data?: T } = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) throw new Error(`BITGET_HTTP_${response.status}`);
    if (String(payload.code ?? '') !== '00000') {
      throw new Error(`BITGET_${String(payload.code ?? 'INVALID')}:${String(payload.msg ?? '요청 실패')}`);
    }
    return payload.data as T;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- 환율 (원/달러) ----

async function loadFx(): Promise<{ fxKrwPerUsd: number | null; fxAsOf: string | null }> {
  try {
    const summary = await MarketDataService.getMarketSummary();
    const usdkrw = summary.find((item) => item.key === 'usdkrw');
    if (usdkrw && usdkrw.ok && usdkrw.price > 0) {
      return { fxKrwPerUsd: usdkrw.price, fxAsOf: new Date().toISOString() };
    }
  } catch (error) {
    console.error('[portfolio] fx load error:', errorMessage(error));
  }
  return { fxKrwPerUsd: null, fxAsOf: null };
}

// ---- 키움 예수금/주문가능금액 조회 (kt00001 예수금상세현황요청, 조회 전용) ----

function pickNumberFromKiwoom(data: KiwoomApiResponse, keys: string[]): number | null {
  for (const key of keys) {
    const raw = (data as Record<string, unknown>)[key];
    if (raw === undefined || raw === null || raw === '') continue;
    // 키움 금액 문자열은 부호/0패딩이 붙는 경우가 있어 정규화한다.
    const normalized = String(raw).trim().replace(/^\+/, '');
    const value = finiteOrNull(normalized);
    if (value !== null) return value;
  }
  return null;
}

async function loadKiwoom(): Promise<KiwoomBalance> {
  const base: KiwoomBalance = {
    available: false,
    deposit: null,
    orderable: null,
    currency: 'KRW',
  };
  try {
    // kt00001: 예수금상세현황요청 (조회 TR). 계좌 예수금/주문가능금액 조회만 수행.
    const { data } = await kiwoomRequest({
      apiId: 'kt00001',
      path: '/api/dostk/acnt',
      body: { qry_tp: '3' },
    });
    const deposit = pickNumberFromKiwoom(data, [
      'entr', // 예수금
      'dpst_bal', // 예수금잔고
      'prsm_dpst', // 추정예수금
    ]);
    const orderable = pickNumberFromKiwoom(data, [
      'ord_alow_amt', // 주문가능금액
      'ord_alowa', // 주문가능금액(약어)
      'wthd_alow_amt', // 출금가능금액(주문가능 폴백)
      'd2_entra', // D+2 추정예수금(폴백)
    ]);
    if (deposit === null && orderable === null) {
      return { ...base, error: '키움 예수금 조회 결과가 비어 있습니다.' };
    }
    return {
      ...base,
      available: true,
      deposit,
      orderable,
    };
  } catch (error) {
    return { ...base, error: errorMessage(error) };
  }
}

// ---- 비트겟 현물 자산 조회 (GET /api/v2/spot/account/assets) ----

async function loadBitgetSpot(): Promise<BitgetSpotBalance> {
  const base: BitgetSpotBalance = { available: false, assets: [], totalUsdt: null };
  try {
    const rows = await bitgetGet<Array<Record<string, unknown>>>('/api/v2/spot/account/assets');
    const list = Array.isArray(rows) ? rows : [];
    const assets: BitgetSpotAsset[] = [];
    for (const row of list) {
      const coin = String(row.coin ?? '').trim().toUpperCase();
      if (!coin) continue;
      const available = finiteOrNull(row.available) ?? 0;
      const frozen = finiteOrNull(row.frozen) ?? 0;
      const locked = finiteOrNull(row.locked) ?? 0;
      const amount = available + frozen + locked;
      if (!(amount > 0)) continue;
      // 현물 자산 개별 USD 평가액은 별도 시세 조회 없이 산출 불가 → null.
      // USDT 계열은 1 USDT ≈ 1 USD 가정으로만 표기.
      const usdValue = coin === 'USDT' || coin === 'USDC' ? amount : null;
      assets.push({ coin, amount, usdValue });
    }
    const totalUsdt = assets.reduce<number | null>((sum, asset) => {
      if (asset.usdValue === null) return sum;
      return (sum ?? 0) + asset.usdValue;
    }, null);
    return { available: true, assets, totalUsdt };
  } catch (error) {
    return { ...base, error: errorMessage(error) };
  }
}

// ---- 비트겟 선물 계좌 조회 (GET /api/v2/mix/account/account, USDT-FUTURES) ----

async function loadBitgetFutures(): Promise<BitgetFuturesBalance> {
  const base: BitgetFuturesBalance = { available: false, availableUsdt: null, equityUsdt: null };
  try {
    const query = `symbol=BTCUSDT&productType=${BITGET_PRODUCT_TYPE}&marginCoin=${BITGET_MARGIN_COIN}`;
    const row = await bitgetGet<Record<string, unknown>>('/api/v2/mix/account/account', query);
    const availableUsdt = finiteOrNull(row?.available);
    const equityUsdt = finiteOrNull(row?.accountEquity ?? row?.usdtEquity);
    if (availableUsdt === null && equityUsdt === null) {
      return { ...base, error: '비트겟 선물 계좌 조회 결과가 비어 있습니다.' };
    }
    return { available: true, availableUsdt, equityUsdt };
  } catch (error) {
    return { ...base, error: errorMessage(error) };
  }
}

// ---- 45초 캐시 ----

let cache: { at: number; value: BalancesResponse } | null = null;

async function buildBalances(): Promise<BalancesResponse> {
  const [fx, kiwoom, bitgetSpot, bitgetFutures] = await Promise.all([
    loadFx(),
    loadKiwoom(),
    loadBitgetSpot(),
    loadBitgetFutures(),
  ]);
  return {
    ok: true,
    dataAsOf: new Date().toISOString(),
    fxKrwPerUsd: fx.fxKrwPerUsd,
    fxAsOf: fx.fxAsOf,
    kiwoom,
    bitgetSpot,
    bitgetFutures,
  };
}

// 인증: requireMember + 정회원(requireFullMember). 포트폴리오는 정회원 기능.
router.get('/portfolio/balances', requireMember, (req, res) => {
  requireFullMember(req as any, res, async () => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const now = Date.now();
      if (cache && now - cache.at < CACHE_TTL_MS) {
        return res.json(cache.value);
      }
      const value = await buildBalances();
      cache = { at: now, value };
      return res.json(value);
    } catch (error) {
      console.error('[portfolio] balances error:', errorMessage(error));
      return res.status(502).json({
        ok: false,
        error: 'PORTFOLIO_BALANCES_UNAVAILABLE',
        message: '데이터를 불러오지 못했습니다.',
      });
    }
  });
});

export default router;
