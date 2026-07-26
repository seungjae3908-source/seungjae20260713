import { Router, type IRouter, type Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  closeShadowPosition,
  getShadowStatus,
  openShadowPosition,
  resetShadowAccount,
  type ShadowDirection,
  type ShadowMarket,
} from '../services/shadow-trading.service';

const router: IRouter = Router();

function memberId(req: AuthenticatedRequest) {
  const id = String(req.member?.id ?? '').trim();
  if (!id) throw new Error('회원 정보를 확인하지 못했습니다.');
  return id;
}

function sendError(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : 'SHADOW_TRADING_ERROR';
  res.status(400).json({
    ok: false,
    mode: 'SHADOW',
    realOrdersEnabled: false,
    error: 'SHADOW_TRADING_REJECTED',
    message,
  });
}

router.get('/status', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    res.json(await getShadowStatus(memberId(req)));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/open', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const result = await openShadowPosition(memberId(req), {
      market: String(req.body?.market ?? '') as ShadowMarket,
      symbol: String(req.body?.symbol ?? ''),
      direction: String(req.body?.direction ?? '') as ShadowDirection,
      notionalKRW: Number(req.body?.notionalKRW),
      stopPrice:
        req.body?.stopPrice == null || req.body?.stopPrice === ''
          ? null
          : Number(req.body.stopPrice),
      targetPrice:
        req.body?.targetPrice == null || req.body?.targetPrice === ''
          ? null
          : Number(req.body.targetPrice),
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/close/:positionId', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    res.json(
      await closeShadowPosition(
        memberId(req),
        String(req.params.positionId ?? ''),
        String(req.body?.reason ?? 'USER_SHADOW_CLOSE'),
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/reset', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    if (String(req.body?.confirmText ?? '') !== 'RESET_200000_SHADOW') {
      throw new Error('가상계좌 초기화 확인문구가 일치하지 않습니다.');
    }
    res.json(await resetShadowAccount(memberId(req)));
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
