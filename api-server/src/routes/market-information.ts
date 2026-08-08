import { Router, type IRouter } from 'express';
import {
  isMarketInformationRoomId,
  MarketInformationError,
  MarketInformationService,
  type MarketInformationResponse,
} from '../services/market-information.service';

export interface MarketInformationRoomReader {
  getRoom(room: Parameters<typeof MarketInformationService.getRoom>[0], signal?: AbortSignal): Promise<MarketInformationResponse>;
}

export function createMarketInformationRouter(service: MarketInformationRoomReader = MarketInformationService): IRouter {
  const router: IRouter = Router();

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
    req.once('aborted', abort);
    res.once('close', abort);

    try {
      const result = await service.getRoom(room, controller.signal);
      res.setHeader('Cache-Control', 'private, no-cache, max-age=0');
      return res.status(200).json(result);
    } catch (error) {
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
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  });

  return router;
}

export default createMarketInformationRouter();
