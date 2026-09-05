import { Router, type IRouter } from 'express';
import {
  emptyDerivatives,
  makeMeta,
  ROOM_CONFIG,
  section,
  type MarketInformationRoomId,
} from '../services/market-information.contract';
import {
  isMarketInformationRoomId,
  MarketInformationError,
  MarketInformationService,
  type MarketInformationResponse,
} from '../services/market-information.service';

export interface MarketInformationRoomReader {
  getRoom(room: Parameters<typeof MarketInformationService.getRoom>[0], signal?: AbortSignal): Promise<MarketInformationResponse>;
}

export interface MarketInformationRouterOptions {
  stockFirstPaintTimeoutMs?: number;
}

const DEFAULT_STOCK_FIRST_PAINT_TIMEOUT_MS = 4_000;
const FIRST_PAINT_TIMEOUT_CODE = 'MARKET_INFORMATION_FIRST_PAINT_TIMEOUT';
type StockRoom = Extract<MarketInformationRoomId, 'stocks-kr' | 'stocks-us'>;

class MarketInformationFirstPaintTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Stock market information exceeded the ${timeoutMs}ms first-paint budget`);
    this.name = 'MarketInformationFirstPaintTimeoutError';
  }
}

function isStockRoom(room: MarketInformationRoomId): room is StockRoom {
  return room === 'stocks-kr' || room === 'stocks-us';
}

function resolveStockFirstPaintTimeout(options: MarketInformationRouterOptions): number {
  const configured = options.stockFirstPaintTimeoutMs;
  if (configured == null) return DEFAULT_STOCK_FIRST_PAINT_TIMEOUT_MS;
  if (!Number.isInteger(configured) || configured < 10 || configured > 30_000) {
    throw new Error('stockFirstPaintTimeoutMs must be an integer between 10 and 30000');
  }
  return configured;
}

function firstPaintUnavailable<T>(room: StockRoom, data: T, message: string) {
  return section('unavailable', data, makeMeta({
    room,
    provider: null,
    source: 'public market provider first-paint guard',
    partial: true,
    unavailableFields: ['all'],
    errorCode: FIRST_PAINT_TIMEOUT_CODE,
    retryable: true,
  }), message);
}

function stockFirstPaintFallback(room: StockRoom): MarketInformationResponse {
  const config = ROOM_CONFIG[room];
  const message = '공개 시장정보 제공기관 응답이 화면 표시 예산을 초과했습니다. 임시 시세나 순위를 만들지 않았으며 새로고침 시 다시 확인합니다.';
  return {
    ok: true,
    room,
    market: config.market,
    assetType: config.assetType,
    currency: config.currency,
    fetchedAt: new Date().toISOString(),
    partial: true,
    sections: {
      indices: firstPaintUnavailable(room, [], message),
      rankings: firstPaintUnavailable(room, [], message),
      sectors: firstPaintUnavailable(room, [], message),
      news: firstPaintUnavailable(room, [], message),
      disclosures: firstPaintUnavailable(room, [], message),
      derivatives: section('unsupported', emptyDerivatives(), makeMeta({
        room,
        provider: null,
        source: null,
        unavailableFields: ['fundingRate', 'openInterest', 'longShortRatio', 'liquidations'],
        errorCode: 'PROVIDER_UNSUPPORTED',
        retryable: false,
      }), '주식 정보방에는 선물 파생지표를 표시하지 않습니다.'),
    },
    requestPolicy: {
      publicMarketDataOnly: true,
      privateExchangeRequests: 0,
      accountRequests: 0,
      balanceRequests: 0,
      positionRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
      aiRequests: 0,
    },
  };
}

export function createMarketInformationRouter(
  service: MarketInformationRoomReader = MarketInformationService,
  options: MarketInformationRouterOptions = {},
): IRouter {
  const router: IRouter = Router();
  const stockFirstPaintTimeoutMs = resolveStockFirstPaintTimeout(options);

  router.get('/:room', async (req, res) => {
    const room = req.params.room;
    if (!isMarketInformationRoomId(room)) {
      return res.status(404).json({
        ok: false,
        errorCode: 'MARKET_INFORMATION_ROOM_NOT_FOUND',
        retryable: false,
        message: '지원하지 않는 시장 정보방입니다.',
      });
    }

    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) controller.abort();
    };
    const abortOnPrematureResponseClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', abortOnPrematureResponseClose);
    let firstPaintTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const roomPromise = service.getRoom(room, controller.signal);
      const result = isStockRoom(room)
        ? await Promise.race([
          roomPromise,
          new Promise<MarketInformationResponse>((_resolve, reject) => {
            firstPaintTimer = setTimeout(() => {
              reject(new MarketInformationFirstPaintTimeoutError(stockFirstPaintTimeoutMs));
            }, stockFirstPaintTimeoutMs);
          }),
        ])
        : await roomPromise;
      res.setHeader('Cache-Control', 'private, no-cache, max-age=0');
      return res.status(200).json(result);
    } catch (error) {
      const timedOut = isStockRoom(room) && error instanceof MarketInformationFirstPaintTimeoutError;
      if (timedOut) {
        res.setHeader('Cache-Control', 'private, no-cache, max-age=0');
        return res.status(200).json(stockFirstPaintFallback(room));
      }
      if (controller.signal.aborted) return undefined;
      const known = error instanceof MarketInformationError
        ? error
        : new MarketInformationError('MARKET_INFORMATION_ERROR', 502, true, '시장정보를 불러오지 못했습니다.');
      return res.status(known.statusCode).json({
        ok: false,
        room,
        errorCode: known.code,
        retryable: known.retryable,
        message: known.message,
        requestPolicy: {
          publicMarketDataOnly: true,
          privateExchangeRequests: 0,
          accountRequests: 0,
          balanceRequests: 0,
          positionRequests: 0,
          orderRequests: 0,
          cancelRequests: 0,
          aiRequests: 0,
        },
      });
    } finally {
      if (firstPaintTimer) clearTimeout(firstPaintTimer);
      req.removeListener('aborted', abort);
      res.removeListener('close', abortOnPrematureResponseClose);
    }
  });

  return router;
}

export default createMarketInformationRouter();
