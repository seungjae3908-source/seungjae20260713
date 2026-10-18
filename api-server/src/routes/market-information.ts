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
  /** First-paint budget once a last confirmed snapshot can stand in for a slow provider. */
  stockSnapshotFirstPaintTimeoutMs?: number;
  stockWarmupDeadlineMs?: number;
  /** Load both stock rooms once at startup; omitted means no provider calls. */
  warmStockRoomsOnStart?: boolean;
}

// Overseas providers (ranking universe, sectors, news, SEC filings) routinely
// need 3-4s on a cold cache, so 2.5s always fell back to "unavailable" for the
// US room. Stay at least 1.5s below the browser's 6s market-information
// request timeout (stock-analyzer/src/lib/auth-fetch.ts).
const DEFAULT_STOCK_FIRST_PAINT_TIMEOUT_MS = 4_500;
// A last confirmed room snapshot is served (clearly marked stale) when a later
// first paint times out, instead of blanking every card.
const STOCK_LAST_GOOD_MAX_AGE_MS = 30 * 60_000;
// Once a snapshot exists the full 4.5s wait only buys fresher data at the cost
// of the page sitting on its loading card: production QA saw /stocks/us still
// busy at 4.8s against a 5s ready budget while an overseas refresh was pending.
// Give a warm cache time to answer, then serve the snapshot and let the
// detached warmup refresh it for the next visit.
const DEFAULT_STOCK_SNAPSHOT_FIRST_PAINT_TIMEOUT_MS = 1_500;
const DEFAULT_STOCK_WARMUP_DEADLINE_MS = 12_000;
const FIRST_PAINT_TIMEOUT_CODE = 'MARKET_INFORMATION_FIRST_PAINT_TIMEOUT';
// A cold US room needs most of the 4.5s first-paint budget on its own, so the
// page misses its 5s ready budget after a restart. Loading both stock rooms once
// at startup fills the provider caches; later requests refresh them through
// stale-while-revalidate. A periodic refresh competed with search for the event
// loop and pushed coin suggest requests past the client's 4.5s budget.
const STOCK_ROOMS = ['stocks-kr', 'stocks-us'] as const;
type StockRoom = Extract<MarketInformationRoomId, 'stocks-kr' | 'stocks-us'>;

class MarketInformationFirstPaintTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Stock market information exceeded the ${timeoutMs}ms first-paint budget`);
    this.name = 'MarketInformationFirstPaintTimeoutError';
  }
}

class MarketInformationWarmupDeadlineError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Stock market information warmup exceeded the ${timeoutMs}ms request budget`);
    this.name = 'MarketInformationWarmupDeadlineError';
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

function resolveStockSnapshotFirstPaintTimeout(
  options: MarketInformationRouterOptions,
  firstPaintTimeoutMs: number,
): number {
  const configured = options.stockSnapshotFirstPaintTimeoutMs
    ?? Math.min(DEFAULT_STOCK_SNAPSHOT_FIRST_PAINT_TIMEOUT_MS, firstPaintTimeoutMs);
  if (!Number.isInteger(configured) || configured < 10 || configured > firstPaintTimeoutMs) {
    throw new Error('stockSnapshotFirstPaintTimeoutMs must be an integer between 10 and stockFirstPaintTimeoutMs');
  }
  return configured;
}

function resolveStockWarmupDeadline(
  options: MarketInformationRouterOptions,
  firstPaintTimeoutMs: number,
): number {
  const configured = options.stockWarmupDeadlineMs ?? DEFAULT_STOCK_WARMUP_DEADLINE_MS;
  if (!Number.isInteger(configured) || configured <= firstPaintTimeoutMs || configured > 60_000) {
    throw new Error('stockWarmupDeadlineMs must be an integer greater than stockFirstPaintTimeoutMs and at most 60000');
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

type LastGoodRoom = { result: MarketInformationResponse; storedAt: number };

function isUsableRoomResult(result: MarketInformationResponse): boolean {
  if (!result || result.ok !== true || !result.sections) return false;
  return Object.values(result.sections).some((value) => value?.status === 'ready' || value?.status === 'partial');
}

function staleSection<T>(value: MarketInformationResponse['sections'][keyof MarketInformationResponse['sections']] & { data: T }, message: string) {
  if (value.status !== 'ready' && value.status !== 'partial' && value.status !== 'stale') return value;
  return {
    ...value,
    status: 'stale' as const,
    meta: {
      ...value.meta,
      isDelayed: true,
      isStale: true,
      partial: true,
      errorCode: FIRST_PAINT_TIMEOUT_CODE,
      retryable: true,
    },
    message,
  };
}

/** Last confirmed snapshot, every live section re-labelled stale with the time it was confirmed. */
export function stockFirstPaintStaleFallback(lastGood: MarketInformationResponse, storedAt: number): MarketInformationResponse {
  const confirmedAt = new Date(storedAt).toISOString();
  const message = `제공기관 응답이 지연되어 ${confirmedAt} 기준 마지막으로 확인한 값을 표시합니다. 새로고침 시 다시 확인합니다.`;
  const sections = lastGood.sections;
  return {
    ...lastGood,
    fetchedAt: new Date().toISOString(),
    partial: true,
    sections: {
      indices: staleSection(sections.indices, message),
      rankings: staleSection(sections.rankings, message),
      sectors: staleSection(sections.sectors, message),
      news: staleSection(sections.news, message),
      disclosures: staleSection(sections.disclosures, message),
      derivatives: sections.derivatives,
    } as MarketInformationResponse['sections'],
  };
}

export function createMarketInformationRouter(
  service: MarketInformationRoomReader = MarketInformationService,
  options: MarketInformationRouterOptions = {},
): IRouter {
  const router: IRouter = Router();
  const stockFirstPaintTimeoutMs = resolveStockFirstPaintTimeout(options);
  const stockSnapshotFirstPaintTimeoutMs = resolveStockSnapshotFirstPaintTimeout(options, stockFirstPaintTimeoutMs);
  const stockWarmupDeadlineMs = resolveStockWarmupDeadline(options, stockFirstPaintTimeoutMs);
  const lastGoodByRoom = new Map<StockRoom, LastGoodRoom>();
  const rememberLastGood = (room: StockRoom, result: MarketInformationResponse) => {
    if (isUsableRoomResult(result)) lastGoodByRoom.set(room, { result, storedAt: Date.now() });
  };
  const usableLastGood = (room: StockRoom): LastGoodRoom | undefined => {
    const lastGood = lastGoodByRoom.get(room);
    if (!lastGood || Date.now() - lastGood.storedAt > STOCK_LAST_GOOD_MAX_AGE_MS) return undefined;
    return lastGood;
  };
  if (options.warmStockRoomsOnStart) {
    setTimeout(() => {
      for (const room of STOCK_ROOMS) {
        void service.getRoom(room, AbortSignal.timeout(stockWarmupDeadlineMs))
          .then((result) => rememberLastGood(room, result), () => undefined);
      }
    }, 0).unref?.();
  }

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
    const abortWithReason = (reason?: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const abort = () => abortWithReason();
    const abortOnPrematureResponseClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', abortOnPrematureResponseClose);
    let firstPaintTimer: ReturnType<typeof setTimeout> | undefined;
    let warmupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let detachedWarmup = false;

    try {
      const roomPromise = service.getRoom(room, controller.signal);
      const clearWarmupDeadline = () => {
        if (warmupDeadlineTimer) clearTimeout(warmupDeadlineTimer);
      };
      void roomPromise.then((value) => {
        clearWarmupDeadline();
        // Detached warmups that finish after the first paint still refresh the snapshot.
        if (isStockRoom(room)) rememberLastGood(room, value);
      }, clearWarmupDeadline);
      // With a snapshot in hand the short budget applies; the warmup keeps its
      // full deadline either way so the snapshot is refreshed for the next visit.
      const firstPaintBudgetMs = isStockRoom(room) && usableLastGood(room)
        ? stockSnapshotFirstPaintTimeoutMs
        : stockFirstPaintTimeoutMs;
      const result = isStockRoom(room)
        ? await Promise.race([
          roomPromise,
          new Promise<MarketInformationResponse>((_resolve, reject) => {
            firstPaintTimer = setTimeout(() => {
              detachedWarmup = true;
              warmupDeadlineTimer = setTimeout(() => {
                abortWithReason(new MarketInformationWarmupDeadlineError(stockWarmupDeadlineMs));
              }, stockWarmupDeadlineMs - firstPaintBudgetMs);
              reject(new MarketInformationFirstPaintTimeoutError(firstPaintBudgetMs));
            }, firstPaintBudgetMs);
          }),
        ])
        : await roomPromise;
      res.setHeader('Cache-Control', 'private, no-cache, max-age=0');
      return res.status(200).json(result);
    } catch (error) {
      const timedOut = isStockRoom(room) && error instanceof MarketInformationFirstPaintTimeoutError;
      if (timedOut) {
        res.setHeader('Cache-Control', 'private, no-cache, max-age=0');
        const lastGood = usableLastGood(room);
        if (lastGood) {
          return res.status(200).json(stockFirstPaintStaleFallback(lastGood.result, lastGood.storedAt));
        }
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
      if (!detachedWarmup && warmupDeadlineTimer) clearTimeout(warmupDeadlineTimer);
      req.removeListener('aborted', abort);
      res.removeListener('close', abortOnPrematureResponseClose);
    }
  });

  return router;
}

// Only the deployed server warms; tests and local runs make no provider calls.
export default createMarketInformationRouter(MarketInformationService, {
  warmStockRoomsOnStart: process.env.NODE_ENV === 'production',
});
