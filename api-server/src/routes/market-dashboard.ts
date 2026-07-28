import { Router, type IRouter } from 'express';
import { requireMember } from '../middleware/auth';
import { RecommendationService } from '../services/recommendation.service';
import { NewsProviderError, NewsService } from '../services/news.service';

const router: IRouter = Router();

type StockMarket = 'KR' | 'US';
type MarketView = StockMarket | 'COIN';

type BriefingIssue = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
};

function normalizeStockMarket(value: unknown): StockMarket {
  return String(value ?? 'KR').toUpperCase() === 'US' ? 'US' : 'KR';
}

function normalizeMarketView(value: unknown): MarketView {
  const market = String(value ?? 'KR').toUpperCase();
  if (market === 'US') return 'US';
  if (market === 'COIN') return 'COIN';
  return 'KR';
}

function uniqueIssues(rows: BriefingIssue[], limit: number): BriefingIssue[] {
  const seen = new Set<string>();
  const output: BriefingIssue[] = [];

  for (const row of rows) {
    const key = `${row.url}|${row.title}`;
    if (!row.url.startsWith('http') || seen.has(key)) continue;
    seen.add(key);
    output.push(row);
    if (output.length >= limit) break;
  }

  return output;
}

router.get('/market/recommendations', requireMember, async (req, res) => {
  const market = normalizeStockMarket(req.query.market);

  try {
    const result = await RecommendationService.getRecommendations(market);
    return res.json(result);
  } catch (error) {
    console.error('market recommendations route error:', error);
    return res.status(502).json({
      ok: false,
      market,
      rows: [],
      error: 'MARKET_RECOMMENDATIONS_ROUTE_ERROR',
      message:
        error instanceof Error
          ? error.message
          : '추천 데이터를 불러오지 못했습니다.',
      fetchedAt: new Date().toISOString(),
    });
  }
});

router.get('/market/news-briefing', requireMember, async (req, res) => {
  const market = normalizeMarketView(req.query.market);
  const asOf = new Date().toISOString();

  if (market === 'COIN') {
    return res.json({
      market,
      asOf,
      stance: '중립',
      headline: '코인 시장 뉴스 브리핑 준비 중',
      summary:
        '현재 연결된 실제 뉴스 공급자는 국내·미국 주식 종목 기준입니다. 코인 뉴스는 지원 공급자 연결 전까지 표시하지 않습니다.',
      reasons: ['가짜 뉴스나 임의 요약을 생성하지 않습니다.'],
      issues: [],
      aiUsed: false,
    });
  }

  try {
    const recommendations = await RecommendationService.getRecommendations(market);
    const rows = recommendations.rows;
    const positiveCount = rows.filter((row) => Number(row.changePercent) > 0).length;
    const negativeCount = rows.filter((row) => Number(row.changePercent) < 0).length;
    const averageChange = rows.length
      ? rows.reduce((sum, row) => sum + Number(row.changePercent || 0), 0) /
        rows.length
      : 0;

    const stance: '강세' | '중립' | '약세' =
      averageChange >= 0.8 && positiveCount > negativeCount
        ? '강세'
        : averageChange <= -0.8 && negativeCount > positiveCount
          ? '약세'
          : '중립';

    const candidateTickers = Array.from(
      new Set(
        [...rows]
          .sort((a, b) => b.score - a.score)
          .map((row) => row.ticker),
      ),
    ).slice(0, 5);

    const newsResults = await Promise.allSettled(
      candidateTickers.map(async (ticker) => ({
        ticker,
        data: await NewsService.getNews(ticker),
      })),
    );

    const issues: BriefingIssue[] = [];
    for (const result of newsResults) {
      if (result.status !== 'fulfilled' || !result.value.data) continue;
      const news = [
        ...result.value.data.positive,
        ...result.value.data.negative,
      ];
      for (const item of news) {
        issues.push({
          title: item.title,
          url: item.url,
          source: item.source,
          publishedAt: item.date,
          summary: item.summary ?? '',
        });
      }
    }

    const selectedIssues = uniqueIssues(issues, 10);
    const reasons = [
      `추천 후보 ${rows.length}개 중 상승 ${positiveCount}개, 하락 ${negativeCount}개`,
      `추천 후보 평균 등락률 ${averageChange >= 0 ? '+' : ''}${averageChange.toFixed(2)}%`,
      `실제 뉴스 ${selectedIssues.length}건 확인`,
    ];

    return res.json({
      market,
      asOf,
      stance,
      headline:
        rows.length === 0
          ? `${market === 'KR' ? '국내' : '미국'} 시장 조건 충족 추천 후보 없음`
          : `${market === 'KR' ? '국내' : '미국'} 시장은 현재 ${stance} 흐름`,
      summary:
        rows.length === 0
          ? '실제 데이터 기준으로 현재 추천 조건을 충족한 종목이 없습니다.'
          : `규칙 기반 추천 후보의 평균 등락률과 실제 종목 뉴스를 종합했습니다. 현재 판단은 ${stance}입니다.`,
      reasons,
      issues: selectedIssues,
      aiUsed: false,
    });
  } catch (error) {
    const providerFailure = error instanceof NewsProviderError;
    console.error('market news briefing route error:', error);
    return res.status(providerFailure ? 502 : 500).json({
      market,
      asOf,
      stance: '중립',
      headline: '시장 브리핑을 불러오지 못했습니다.',
      summary: '실제 데이터 공급자 응답을 확인해 주세요.',
      reasons: [],
      issues: [],
      aiUsed: false,
      error: providerFailure
        ? 'NEWS_PROVIDER_ERROR'
        : 'MARKET_NEWS_BRIEFING_ROUTE_ERROR',
      message: error instanceof Error ? error.message : '시장 브리핑 오류',
    });
  }
});

export default router;
