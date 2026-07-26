import { Router, type IRouter } from 'express';
import healthRouter from './health';
import marketRouter from './market';
import newsRouter from './news.route';
import providerDebugRouter from './provider-debug';
import pushRouter from './push';
import stocksRouter from './stocks';
import watchlistRouter from './watchlist';
import kiwoomRouter from './kiwoom.routes';
import adminRouter from './admin';
import secRouter from './sec.routes';
import cryptoRouter from './crypto';
import cryptoSpotAutoRouter from './crypto-spot-auto';
import shadowTradingRouter from './shadow-trading';
import backupRouter from './backup';
import authRouter from './auth';
import analysisRouter from './analysis';
import portfolioRouter from './portfolio';
import {
  requireAdmin,
  requireFullMember,
  requireMember,
} from '../middleware/auth';

const router: IRouter = Router();

router.get('/', (_req, res) => {
  res.json({ ok: true, service: 'seungjae-stock-api' });
});

router.use('/', healthRouter);
router.use('/auth', authRouter);

// 승인된 준회원 이상은 일반 시장·분석·정보 기능을 사용할 수 있습니다.
// 관리자 작업만 별도 관리자 게이트를 유지합니다.
router.use('/market/themes/rebuild', requireMember, requireAdmin);
router.use('/market/themes/review', requireMember, requireAdmin);
router.use('/market/sector-popular', requireMember);
router.use('/market/briefing', requireMember);
router.use('/market/themes', requireMember);
router.use('/market/scan', requireMember);
router.use('/market/recommendations', requireMember);
router.use('/market/undervalued', requireMember);
router.use('/', marketRouter);

router.use('/', newsRouter);
router.use('/kiwoom', kiwoomRouter);

// 20만 원 가상계좌 섀도 모드. 실제 주문 API를 호출하지 않으며 관리자만 사용합니다.
router.use(
  '/auto-trading/shadow',
  requireMember,
  requireAdmin,
  shadowTradingRouter,
);

// 코인 현물 실제 주문은 관리자만 사용하며 주문계획과 최종 승인을 분리합니다.
router.use(
  '/crypto/spot/auto',
  requireMember,
  requireAdmin,
  cryptoSpotAutoRouter,
);

// 코인 선물 조회는 정회원 이상, 실제 자동매매 API는 관리자만 사용합니다.
router.use('/crypto/futures/auto', requireMember, requireFullMember, requireAdmin);
router.use('/crypto/futures', requireMember, requireFullMember);
router.use('/', cryptoRouter);

// 시그널 스캔·차트 신호·AI 플랜·시장 분석.
// 라우트 내부에서 승인회원/선물 권한을 추가 검사합니다.
router.use('/', analysisRouter);

// 잔액·포트폴리오 조회 라우트 내부 권한 검사 유지.
router.use('/', portfolioRouter);

// 관리자 라우터 내부에서도 회원·관리자 검사를 다시 수행합니다.
router.use('/admin', adminRouter);

// 이 아래 기능은 모두 승인된 준회원 이상만 접근합니다.
router.use(requireMember);
router.use('/debug', requireAdmin, providerDebugRouter);

// 실제 주식 자동매매 API는 관리자만 접근합니다.
router.use('/stocks/auto-trade', requireAdmin);

// 관심종목·알림·설정 백업과 일반 주식 정보는 준회원 이상에게 제공합니다.
router.use('/', pushRouter);
router.use('/', watchlistRouter);
router.use('/stocks', stocksRouter);
router.use('/', secRouter);
router.use('/backup', backupRouter);

export default router;
