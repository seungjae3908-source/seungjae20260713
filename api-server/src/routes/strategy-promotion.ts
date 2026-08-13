import { Router, type IRouter } from 'express';
import {
  createDefaultStrategyPromotionService,
  type StrategyPromotionService,
} from '../services/strategy-promotion.service';

export function createStrategyPromotionRouter(service: StrategyPromotionService = createDefaultStrategyPromotionService()): IRouter {
  const router: IRouter = Router();

  router.get('/strategy-promotion', (req, res) => {
    const result = service.list({
      market: typeof req.query.market === 'string' ? req.query.market : undefined,
      direction: typeof req.query.direction === 'string' ? req.query.direction : undefined,
    });
    return res.json({ ok: true, ...result });
  });

  router.get('/strategy-promotion/:strategyId/history', (req, res) => {
    const result = service.history(String(req.params.strategyId));
    return result
      ? res.json({ ok: true, ...result })
      : res.status(404).json({ ok: false, error: 'STRATEGY_PROMOTION_NOT_FOUND', executionAuthority: 'NONE' });
  });

  router.get('/strategy-promotion/:strategyId/evidence', (req, res) => {
    const result = service.evidenceFor(String(req.params.strategyId));
    return result
      ? res.json({ ok: true, ...result })
      : res.status(404).json({ ok: false, error: 'STRATEGY_PROMOTION_NOT_FOUND', executionAuthority: 'NONE' });
  });

  router.get('/strategy-promotion/:strategyId', (req, res) => {
    const result = service.get(String(req.params.strategyId));
    return result
      ? res.json({ ok: true, item: result })
      : res.status(404).json({ ok: false, error: 'STRATEGY_PROMOTION_NOT_FOUND', executionAuthority: 'NONE' });
  });

  return router;
}

export default createStrategyPromotionRouter();
