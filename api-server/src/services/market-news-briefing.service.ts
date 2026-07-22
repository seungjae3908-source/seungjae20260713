import { fetchText } from '../lib/http';

export type NewsBriefingMarket = 'KR' | 'US' | 'COIN';
type Stance = '강세' | '중립' | '약세';

export interface MarketNewsIssue {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
}

export interface MarketNewsBriefing {
  market: NewsBriefingMarket;
  asOf: string;
  stance: Stance;
  headline: string;
  summary: string;
  reasons: string[];
  issues: MarketNewsIssue[];
  aiUsed: boolean;
}

interface RawNewsIssue {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

interface ArticleIssue extends RawNewsIssue {
  articleUrl: string;
  body: string;
}

interface AnalysisResult {
  stance: Stance;
  headline: string;
  summary: string;
  itemSummaries: string[];
}

const CACHE_MS = 60 * 1000;
const cache = new Map<NewsBriefingMarket, { expiresAt: number; value: MarketNewsBriefing }>();

const QUERIES: Record<
  NewsBriefingMarket,
  { query: string; hl: string; gl: string; ceid: string; label: string }
> = {
  KR: {
    query: '한국 증시 코스피 금융 정책 금리 환율 기업 실적 when:1d',
    hl: 'ko',
    gl: 'KR',
    ceid: 'KR:ko',
    label: '국내 증시',
  },
  US: {
    query: 'US stock market Federal Reserve earnings economy regulation when:1d',
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
    label: '해외 증시',
  },
  COIN: {
    query: '암호화폐 비트코인 시장 규제 ETF 금리 거래소 when:1d',
    hl: 'ko',
    gl: 'KR',
    ceid: 'KR:ko',
    label: '코인 시장',
  },
};

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_all, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function plainText(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(block: string, pattern: RegExp): string {
  const match = block.match(pattern);
  return match ? plainText(match[1]) : '';
}

function parseIssues(xml: string): RawNewsIssue[] {
  const issues: RawNewsIssue[] = [];
  const seen = new Set<string>();
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null && issues.length < 15) {
    const block = match[1];
    const title = pick(block, /<title>([\s\S]*?)<\/title>/);
    const url = pick(block, /<link>([\s\S]*?)<\/link>/);
    const source = pick(block, /<source[^>]*>([\s\S]*?)<\/source>/) || 'Google News';
    const pubDate = pick(block, /<pubDate>([\s\S]*?)<\/pubDate>/);
    const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim();

    if (!title || !url.startsWith('http') || seen.has(normalized)) continue;
    seen.add(normalized);

    issues.push({
      title,
      url,
      source,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }

  return issues;
}

async function fetchIssues(market: NewsBriefingMarket): Promise<RawNewsIssue[]> {
  const config = QUERIES[market];
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(config.query)}&hl=${config.hl}&gl=${config.gl}&ceid=${config.ceid}`;
  const xml = await fetchText(url, {
    provider: 'google-market-news',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  return parseIssues(xml);
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function extractCandidateUrls(html: string): string[] {
  const normalized = decodeEntities(
    html
      .replace(/\\u003d/gi, '=')
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/'),
  );
  const values = normalized.match(/https?:\/\/[^\s"'<>\\]+/g) ?? [];
  const seen = new Set<string>();

  return values
    .map((value) => value.replace(/[),.;]+$/, ''))
    .filter((value) => {
      if (!isPublicHttpUrl(value) || seen.has(value)) return false;
      const host = new URL(value).hostname.toLowerCase();
      if (
        host.includes('google.') ||
        host.includes('gstatic.') ||
        host.includes('googleusercontent.')
      ) {
        return false;
      }
      seen.add(value);
      return true;
    });
}

function extractArticleBody(html: string): string {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  const body = article ?? main ?? html;

  return plainText(
    body
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' '),
  ).slice(0, 8000);
}

async function fetchHtml(url: string): Promise<{ finalUrl: string; html: string }> {
  if (!isPublicHttpUrl(url)) throw new Error('허용되지 않은 기사 URL입니다.');

  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) throw new Error(`기사 본문 응답 오류: ${response.status}`);
  if (!isPublicHttpUrl(response.url)) throw new Error('기사 이동 URL이 허용되지 않습니다.');

  return {
    finalUrl: response.url,
    html: await response.text(),
  };
}

async function fetchArticle(issue: RawNewsIssue): Promise<ArticleIssue> {
  try {
    const first = await fetchHtml(issue.url);
    let articleUrl = first.finalUrl;
    let html = first.html;
    let body = extractArticleBody(html);

    if (new URL(articleUrl).hostname.toLowerCase().includes('news.google.')) {
      for (const candidate of extractCandidateUrls(html).slice(0, 4)) {
        try {
          const page = await fetchHtml(candidate);
          const candidateBody = extractArticleBody(page.html);
          if (candidateBody.length > body.length && candidateBody.length >= 250) {
            articleUrl = page.finalUrl;
            html = page.html;
            body = candidateBody;
            break;
          }
        } catch {
          // 다음 후보 URL을 확인한다.
        }
      }
    }

    return {
      ...issue,
      articleUrl,
      body: body.length >= 160 ? body : '',
    };
  } catch (error) {
    console.error(`market article fetch fallback (${issue.source}):`, error);
    return {
      ...issue,
      articleUrl: issue.url,
      body: '',
    };
  }
}

function splitSentences(body: string): string[] {
  return body
    .split(/(?<=[.!?。]|다\.)\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 30 && value.length <= 420);
}

function fallbackItemSummary(body: string): string {
  if (!body) return '기사 원문 제공기관의 응답을 기다리고 있습니다.';
  const sentences = splitSentences(body);
  return (sentences.slice(0, 2).join(' ') || body).slice(0, 240).trim();
}

function fallbackAnalysis(market: NewsBriefingMarket, issues: ArticleIssue[]): AnalysisResult {
  const summaries = issues.map((issue) => fallbackItemSummary(issue.body));
  const available = summaries.filter(
    (value) => !value.includes('응답을 기다리고 있습니다'),
  );
  const summary = available.slice(0, 3).join(' ');

  return {
    stance: '중립',
    headline: summary
      ? summary.slice(0, 90)
      : `${QUERIES[market].label} 기사 원문을 분석하고 있습니다.`,
    summary:
      summary ||
      '기사 원문 제공기관의 응답이 지연되어 새로운 시장 분석을 준비하고 있습니다.',
    itemSummaries: summaries,
  };
}

function extractResponseText(payload: any): string {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const parts: string[] = [];

  for (const output of payload?.output ?? []) {
    for (const content of output?.content ?? []) {
      if (typeof content?.text === 'string') parts.push(content.text);
    }
  }

  return parts.join('\n').trim();
}

function parseJsonText(text: string): any {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 응답 JSON을 찾지 못했습니다.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function analyzeWithAi(
  market: NewsBriefingMarket,
  issues: ArticleIssue[],
): Promise<AnalysisResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY가 없습니다.');

  const model =
    process.env.OPENAI_MARKET_BRIEFING_MODEL?.trim() ||
    process.env.OPENAI_REPAIR_MODEL?.trim() ||
    'gpt-5.1';

  const articleText = issues
    .map(
      (issue, index) =>
        `${index + 1}. 출처: ${issue.source}\n기사 원문 본문:\n${issue.body || '본문 수집 지연'}`,
    )
    .join('\n\n');

  const prompt = `
당신은 한국어 금융시장 뉴스 분석가입니다.
분석 대상: ${QUERIES[market].label}

아래 5개 실제 기사 원문 본문을 종합해서 현재 시장에 영향을 주는 핵심 내용을 분석하세요.
기사 제목을 복사하거나 제목처럼 다시 쓰지 마세요.
현대차, 삼성전자, 반도체, 코스피, 코스닥처럼 원문에 실제로 나온 기업·산업·지수 이름은 구체적으로 사용하세요.
예를 들어 특정 기업의 매도세, 반도체 수요, 정책 변화, 금리, 환율, 실적, 규제 등이 시장에 어떤 영향을 주는지 연결해서 설명하세요.
가격 상승·하락 수치만 보고 강세·약세를 정하지 말고 원인과 파급효과를 기준으로 판단하세요.
원문에 없는 사실은 만들지 말고 확정적인 투자 예측을 하지 마세요.

반드시 아래 JSON만 출력하세요.
{
  "stance": "강세 또는 중립 또는 약세",
  "headline": "5개 기사 본문을 종합한 오늘 시장 핵심 분석 한 문장",
  "summary": "기사 본문 속 구체적인 기업·산업·정책 요인을 연결한 종합 분석 3~5문장",
  "items": [
    { "index": 1, "summary": "1번 기사 본문 핵심과 시장 영향 요약" },
    { "index": 2, "summary": "2번 기사 본문 핵심과 시장 영향 요약" },
    { "index": 3, "summary": "3번 기사 본문 핵심과 시장 영향 요약" },
    { "index": 4, "summary": "4번 기사 본문 핵심과 시장 영향 요약" },
    { "index": 5, "summary": "5번 기사 본문 핵심과 시장 영향 요약" }
  ]
}

기사 원문:
${articleText}
`.trim();

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: 1400,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`시장 뉴스 AI 분석 실패: ${response.status} ${message.slice(0, 200)}`);
  }

  const parsed = parseJsonText(extractResponseText(await response.json()));
  const stance: Stance =
    parsed.stance === '강세' || parsed.stance === '약세' ? parsed.stance : '중립';
  const indexed = new Map<number, string>();

  if (Array.isArray(parsed.items)) {
    for (const item of parsed.items) {
      const index = Number(item?.index);
      const summary = String(item?.summary ?? '').trim();
      if (Number.isInteger(index) && index >= 1 && index <= 5 && summary) {
        indexed.set(index, summary);
      }
    }
  }

  return {
    stance,
    headline:
      String(parsed.headline ?? '').trim() ||
      `${QUERIES[market].label} 기사 원문 종합 분석`,
    summary:
      String(parsed.summary ?? '').trim() ||
      '오늘 수집된 기사 원문을 종합해 시장 영향을 분석했습니다.',
    itemSummaries: issues.map(
      (issue, index) => indexed.get(index + 1) || fallbackItemSummary(issue.body),
    ),
  };
}

async function getBriefing(market: NewsBriefingMarket): Promise<MarketNewsBriefing> {
  const cached = cache.get(market);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const selected = (await fetchIssues(market)).slice(0, 5);
  const articles = await Promise.all(selected.map((issue) => fetchArticle(issue)));
  let analysis: AnalysisResult;
  let aiUsed = false;

  try {
    if (articles.filter((issue) => issue.body.length >= 160).length < 2) {
      throw new Error('분석할 기사 원문이 충분하지 않습니다.');
    }
    analysis = await analyzeWithAi(market, articles);
    aiUsed = true;
  } catch (error) {
    console.error(`market news AI briefing fallback (${market}):`, error);
    analysis = fallbackAnalysis(market, articles);
  }

  const value: MarketNewsBriefing = {
    market,
    asOf: new Date().toISOString(),
    stance: analysis.stance,
    headline: analysis.headline,
    summary: analysis.summary,
    reasons: [],
    issues: articles.map((issue, index) => ({
      title: issue.title,
      url: issue.articleUrl || issue.url,
      source: issue.source,
      publishedAt: issue.publishedAt,
      summary: analysis.itemSummaries[index] || fallbackItemSummary(issue.body),
    })),
    aiUsed,
  };

  cache.set(market, {
    expiresAt: Date.now() + CACHE_MS,
    value,
  });

  return value;
}

export const MarketNewsBriefingService = {
  getBriefing,
};
