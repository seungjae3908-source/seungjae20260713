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

// 시장 기본 시세·검색은 승인 회원이 사용할 수 있습니다.
// 고급 검색·추천·AI 브리핑은 정회원 이상만 통과합니다.
router.use('/market/themes/rebuild', requireMember, requireAdmin);
router.use('/market/themes/review', requireMember, requireAdmin);
router.use('/market/sector-popular', requireMember, requireFullMember);
router.use('/market/briefing', requireMember, requireFullMember);
router.use('/market/themes', requireMember, requireFullMember);
router.use('/market/scan', requireMember, requireFullMember);
router.use('/market/recommendations', requireMember, requireFullMember);
router.use('/market/undervalued', requireMember, requireFullMember);
router.use('/', marketRouter);

router.use('/', newsRouter);
router.use('/kiwoom', kiwoomRouter);

// 코인 선물(비트겟) 시세·계좌는 정회원 이상만 사용합니다. 현물 시세는 공개 유지.
router.use('/crypto/futures', requireMember, requireFullMember);
router.use('/', cryptoRouter);

// 3차 신규 분석 API (시그널 스캔·차트 신호·AI 플랜·시장 분석).
// 각 라우트 내부에서 requireMember/requireFullMember(futures) 게이트를 직접 적용한다.
router.use('/', analysisRouter);

// 4차 신규 잔액 조회 API (조회 전용). 라우트 내부에서 requireMember/requireFullMember 게이트 적용.
router.use('/', portfolioRouter);

// 관리자 라우터 내부에서도 회원·관리자 검사를 다시 수행합니다.
router.use('/admin', adminRouter);

router.use(requireMember);
router.use('/debug', requireAdmin, providerDebugRouter);

// 알림(가격 알림 포함)과 관심종목은 정회원 이상 전용입니다.
router.use('/notifications', requireFullMember);
router.use('/push', requireFullMember);
router.use('/', pushRouter);
router.use('/watchlist', requireFullMember);
router.use('/', watchlistRouter);

// 기본 차트에 필요한 quote/company/profile/chart/candles는 준회원도 사용합니다.
// 아래 고급 분석 데이터는 정회원 이상만 반환합니다.
router.use('/stocks/special-feed', requireFullMember);
router.use('/stocks/:ticker/rating', requireFullMember);
router.use('/stocks/:ticker/financials', requireFullMember);
router.use('/stocks/:ticker/risk', requireFullMember);
router.use('/stocks/:ticker/filings', requireFullMember);
router.use('/stocks/:ticker/disclosures', requireFullMember);
router.use('/stocks/:ticker/news', requireFullMember);
router.use('/stocks/:ticker/market-flow', requireFullMember);
router.use('/stocks/:ticker/short-selling', requireFullMember);
router.use('/stocks', stocksRouter);

router.use('/', secRouter);
// 포트폴리오 백업(서버 저장)도 정회원 이상 전용입니다.
router.use('/backup', requireFullMember, backupRouter);

export default router;
