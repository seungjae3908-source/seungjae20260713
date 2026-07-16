// SEC EDGAR 전용 라우트 + 공시 별칭 라우트.
// - GET /api/sec/:ticker/filings       최신 filings (실제 EDGAR 문서 링크)
// - GET /api/sec/:ticker/companyfacts  XBRL company facts 요약
// - GET /api/disclosures/:ticker       국내(DART)·미국(SEC) 공시 별칭
// SEC User-Agent 는 환경변수 SEC_USER_AGENT 로 관리한다 (lib/config.ts).
import { Router, type IRouter } from 'express';
import { getFilings, getCompanyFactsSummary } from '../providers/sec-edgar';
import { FilingService } from '../services/filing.service';

const router: IRouter = Router();

function isUsTicker(value: string): boolean {
  return /^[A-Z.\-]{1,10}$/.test(value) && !/^\d{6}$/.test(value);
}

router.get('/sec/:ticker/filings', async (req, res) => {
  const ticker = String(req.params.ticker || '').trim().toUpperCase();
  const fetchedAt = new Date().toISOString();
  if (!isUsTicker(ticker)) {
    return res.status(400).json({ ok: false, error: 'INVALID_US_TICKER' });
  }
  try {
    const rows = await getFilings(ticker, 20);
    return res.json({ ok: true, provider: 'sec-edgar', fetchedAt, ticker, rows, count: rows.length });
  } catch (error) {
    console.error('sec filings route error:', error);
    return res.status(502).json({ ok: false, provider: 'sec-edgar', error: 'SEC_PROVIDER_ERROR', message: 'SEC EDGAR 조회에 실패했습니다.' });
  }
});

router.get('/sec/:ticker/companyfacts', async (req, res) => {
  const ticker = String(req.params.ticker || '').trim().toUpperCase();
  const fetchedAt = new Date().toISOString();
  if (!isUsTicker(ticker)) {
    return res.status(400).json({ ok: false, error: 'INVALID_US_TICKER' });
  }
  try {
    const facts = await getCompanyFactsSummary(ticker);
    return res.json({ ok: true, provider: 'sec-edgar', fetchedAt, ticker, ...facts });
  } catch (error) {
    console.error('sec companyfacts route error:', error);
    return res.status(502).json({ ok: false, provider: 'sec-edgar', error: 'SEC_PROVIDER_ERROR', message: 'SEC EDGAR company facts 조회에 실패했습니다.' });
  }
});

// 공시 별칭: 6자리 숫자면 DART(국내), 아니면 SEC(미국)로 FilingService가 분기한다.
router.get('/disclosures/:ticker', async (req, res) => {
  const ticker = String(req.params.ticker || '').trim().toUpperCase();
  const fetchedAt = new Date().toISOString();
  try {
    const result = await FilingService.getFilings(ticker);
    if (!result) return res.status(404).json({ ok: false, error: 'TICKER_NOT_FOUND' });
    const provider = result.market === 'KR' ? 'dart' : 'sec-edgar';
    return res.json({ ok: true, provider, fetchedAt, ticker, ...result });
  } catch (error) {
    console.error('disclosures alias route error:', error);
    const provider = /^\d{6}$/.test(ticker) ? 'dart' : 'sec-edgar';
    return res.status(502).json({ ok: false, provider, error: 'DISCLOSURE_PROVIDER_ERROR', message: '공시 공급자 조회에 실패했습니다.' });
  }
});

export default router;
