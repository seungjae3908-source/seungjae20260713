import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketDataService } from './market-data.service';
import { NewsService } from './news.service';
import { FinancialService } from './financial.service';
import { AiChatError, answerAiChat } from './ai-chat.service';
import type { CompanyProfile, Financials, NewsData, Quote } from '../sample/types';

type StockMarket = 'KR' | 'US';
type StockFixture = {
  market: StockMarket;
  symbol: string;
  displayName: string;
  currency: 'KRW' | 'USD';
  price: number;
};

type GeminiRequestBody = {
  contents?: Array<{ parts?: Array<{ text?: string }> }>;
};

type PublicContextPrompt = {
  task?: string;
  question?: string;
  publicContext?: {
    selection?: { market?: string; symbol?: string; displayName?: string };
    quote?: Record<string, unknown>;
    company?: Record<string, unknown> | null;
    news?: { sentimentScore?: number; items?: Array<Record<string, unknown>> } | null;
    financials?: Record<string, unknown> | null;
    data?: { status?: string; sources?: string[]; missing?: string[] };
  };
};

const environmentKeys = [
  'AI_CHAT_PROVIDER',
  'AI_CHAT_API_KEY',
  'AI_CHAT_MODEL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_MODEL',
  'TRADING_REVIEW_PROVIDER',
  'TRADING_REVIEW_API_KEY',
  'TRADING_REVIEW_MODEL',
] as const;

function snapshotEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
}

function clearEnvironment(): void {
  for (const key of environmentKeys) delete process.env[key];
}

function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const key of environmentKeys) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function quoteFixture(price: number): Quote {
  return {
    price,
    changeAmount: 1.25,
    changePercent: 1.1,
    volume: 1_234_567,
    marketCap: 2_000_000_000,
    week52High: price * 1.2,
    week52Low: price * 0.7,
  };
}

function companyFixture(fixture: StockFixture): CompanyProfile {
  return {
    ticker: fixture.symbol,
    name: fixture.displayName,
    market: fixture.market,
    currency: fixture.currency,
    description: `${fixture.displayName} public company profile`,
    industry: 'Technology',
    sector: 'Information Technology',
    country: fixture.market === 'KR' ? 'KR' : 'US',
    mainBusiness: 'Public market fixture business',
    competitors: [],
  };
}

function newsFixture(fixture: StockFixture): NewsData {
  return {
    positive: [{
      title: `${fixture.displayName} public market update`,
      source: 'fixture-news',
      sourceDomain: 'news.example.invalid',
      date: '2026-08-11',
      url: 'https://news.example.invalid/public-market-update',
      tone: 'positive',
      summary: 'Deterministic public-news fixture.',
    }],
    negative: [],
    sentimentScore: 100,
  };
}

function financialFixture(): Financials {
  return {
    source: 'live',
    quarterly: [],
    annual: [],
    ratios: { eps: 12.34, per: 18.2, pbr: 2.1, roe: 14.8, debtRatio: 42.5 },
    growth: { revenue: [], profit: [] },
    cashBurn: { cashBalance: 1_000_000, quarterlyBurn: 100_000, survivalQuarters: null },
    health: { level: 'STRONG', confidence: 82 },
  };
}

function installPublicStockMocks(fixture: StockFixture) {
  const originalQuote = MarketDataService.getQuote;
  const originalCompany = MarketDataService.getCompanyProfile;
  const originalNews = NewsService.getNews;
  const originalFinancials = FinancialService.getFinancials;
  const calls = { quote: 0, company: 0, news: 0, financials: 0 };

  MarketDataService.getQuote = async (ticker: string) => {
    calls.quote += 1;
    assert.equal(ticker, fixture.symbol);
    return quoteFixture(fixture.price);
  };
  MarketDataService.getCompanyProfile = async (ticker: string) => {
    calls.company += 1;
    assert.equal(ticker, fixture.symbol);
    return companyFixture(fixture);
  };
  NewsService.getNews = async (ticker: string) => {
    calls.news += 1;
    assert.equal(ticker, fixture.symbol);
    return newsFixture(fixture);
  };
  FinancialService.getFinancials = async (ticker: string) => {
    calls.financials += 1;
    assert.equal(ticker, fixture.symbol);
    return financialFixture();
  };

  return {
    calls,
    restore() {
      MarketDataService.getQuote = originalQuote;
      MarketDataService.getCompanyProfile = originalCompany;
      NewsService.getNews = originalNews;
      FinancialService.getFinancials = originalFinancials;
    },
  };
}

function readPublicContextFromGeminiRequest(init: RequestInit | undefined): PublicContextPrompt {
  const requestBody = JSON.parse(String(init?.body ?? '{}')) as GeminiRequestBody;
  const promptText = requestBody.contents?.[0]?.parts?.[0]?.text ?? '';
  assert.ok(promptText, 'provider request must include the public-context prompt');
  return JSON.parse(promptText) as PublicContextPrompt;
}

const stockCases: StockFixture[] = [
  { market: 'KR', symbol: '005930', displayName: '삼성전자', currency: 'KRW', price: 75_123 },
  { market: 'US', symbol: 'AAPL', displayName: 'Apple', currency: 'USD', price: 231.45 },
];

for (const fixture of stockCases) {
  test(`AI ${fixture.market} request context sends only public ${fixture.symbol} market data to the provider`, async () => {
    const previousEnvironment = snapshotEnvironment();
    const mocks = installPublicStockMocks(fixture);
    clearEnvironment();
    process.env.GEMINI_API_KEY = 'expanded-evidence-gemini-key';
    let providerCalls = 0;
    try {
      const result = await answerAiChat({
        message: `${fixture.displayName} 현재 시장 데이터와 최근 뉴스를 요약해줘`,
        context: { market: fixture.market, symbol: fixture.symbol, displayName: fixture.displayName },
      }, async (_url, init) => {
        providerCalls += 1;
        const prompt = readPublicContextFromGeminiRequest(init);
        assert.equal(prompt.task, 'answer_or_summarize_public_financial_information');
        const context = prompt.publicContext;
        assert.ok(context, 'publicContext must be present');
        assert.deepEqual(context.selection, {
          market: fixture.market,
          symbol: fixture.symbol,
          displayName: fixture.displayName,
        });
        assert.equal(context.quote?.price, fixture.price);
        assert.equal(context.company?.market, fixture.market);
        assert.equal(context.company?.name, fixture.displayName);
        assert.equal(context.news?.items?.[0]?.source, 'fixture-news');
        assert.equal(context.financials?.source, 'live');
        assert.equal(context.data?.status, 'complete');
        assert.deepEqual(context.data?.missing, []);
        const serializedContext = JSON.stringify(context);
        assert.doesNotMatch(serializedContext, /(?:account|balance|position|credential|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|orderPayload|orderId)/i);
        assert.doesNotMatch(serializedContext, /expanded-evidence-gemini-key/);
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: `${fixture.symbol} 공개 시장 컨텍스트를 확인했습니다.` }] } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      });

      assert.equal(result.kind, 'answer');
      assert.equal(result.data.status, 'complete');
      assert.equal(providerCalls, 1);
      assert.deepEqual(mocks.calls, { quote: 1, company: 1, news: 1, financials: 1 });
    } finally {
      mocks.restore();
      restoreEnvironment(previousEnvironment);
    }
  });
}

test('AI provider failure is single-attempt, fail-closed, and never falls back to trading-review credentials', async () => {
  const fixture = stockCases[1];
  const previousEnvironment = snapshotEnvironment();
  const mocks = installPublicStockMocks(fixture);
  clearEnvironment();
  process.env.GEMINI_API_KEY = 'expanded-evidence-gemini-key';
  process.env.TRADING_REVIEW_PROVIDER = 'openai-compatible';
  process.env.TRADING_REVIEW_API_KEY = 'must-not-be-used-paid-key';
  process.env.TRADING_REVIEW_MODEL = 'must-not-be-used-paid-model';
  let providerCalls = 0;
  try {
    await assert.rejects(
      answerAiChat({
        message: 'Apple 현재 시장 데이터를 요약해줘',
        context: { market: 'US', symbol: 'AAPL', displayName: 'Apple' },
      }, async (_url, init) => {
        providerCalls += 1;
        const prompt = readPublicContextFromGeminiRequest(init);
        assert.equal(prompt.publicContext?.selection?.market, 'US');
        assert.equal(prompt.publicContext?.selection?.symbol, 'AAPL');
        assert.doesNotMatch(JSON.stringify(prompt), /must-not-be-used-paid-key/);
        return new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }),
      (cause: unknown) => cause instanceof AiChatError
        && cause.code === 'AI_CHAT_PROVIDER_ERROR'
        && cause.statusCode === 502,
    );
    assert.equal(providerCalls, 1, 'provider failure must not retry or switch providers');
    assert.deepEqual(mocks.calls, { quote: 1, company: 1, news: 1, financials: 1 });
  } finally {
    mocks.restore();
    restoreEnvironment(previousEnvironment);
  }
});
