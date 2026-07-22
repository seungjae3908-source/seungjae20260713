export type NewsBriefingMarket = 'KR' | 'US' | 'COIN';

type NewsStance = '강세' | '중립' | '약세';

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
  stance: NewsStance;
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

interface ArticleNewsIssue extends RawNewsIssue {
  index: number;
  articleUrl: string;
  body: string;
}

interface AiAnalysis {
  stance: NewsStance;
  headline: string;
  summary: string;
  itemSummaries: string[];
}

const CACHE_MS = 60_000;

const cache = new Map<
  NewsBriefingMarket,
  {
    expiresAt: number;
    data: MarketNewsBriefing;
  }
>();

const MARKET_CONFIG: Record<
  NewsBriefingMarket,
  {
    label: string;
    query: string;
    hl: string;
    gl: string;
    ceid: string;
  }
> = {
  KR: {
    label: '국내 증시',
    query:
      '한국 증시 코스피 코스닥 삼성전자 반도체 자동차 금융 정책 금리 환율 수급 실적 when:1d',
    hl: 'ko',
    gl: 'KR',
    ceid: 'KR:ko',
  },

  US: {
    label: '해외 증시',
    query:
      'US stock market Nasdaq S&P 500 Federal Reserve semiconductor earnings economy regulation when:1d',
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  },

  COIN: {
    label: '코인 시장',
    query:
      '암호화폐 비트코인 이더리움 ETF 규제 금리 거래소 시장 when:1d',
    hl: 'ko',
    gl: 'KR',
    ceid: 'KR:ko',
  },
};

const EXTRA_QUERIES: Record<NewsBriefingMarket, string[]> = {
  KR: [
    '코스피 코스닥 외국인 기관 수급 반도체 자동차 금융 when:1d',
    '삼성전자 SK하이닉스 AI 반도체 국내 증시 when:1d',
  ],
  US: [
    'Wall Street Nasdaq S&P 500 stocks earnings Fed when:1d',
    'US semiconductor AI stocks regulation economy when:1d',
  ],
  COIN: [
    'Bitcoin Ethereum crypto market ETF regulation exchange when:1d',
    '비트코인 이더리움 알트코인 ETF 거래소 규제 when:1d',
  ],
};

function decodeHtml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_match, code) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(value: string): string {
  return decodeHtml(
    value.replace(/<[^>]*>/g, ' '),
  );
}

function readXmlValue(
  block: string,
  pattern: RegExp,
): string {
  const match = block.match(pattern);

  return match
    ? stripTags(match[1])
    : '';
}

function safeIsoDate(value: string): string {
  const date = value
    ? new Date(value)
    : new Date();

  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function parseRss(xml: string): RawNewsIssue[] {
  const issues: RawNewsIssue[] = [];
  const duplicate = new Set<string>();
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;

  let match: RegExpExecArray | null;

  while (
    (match = itemPattern.exec(xml)) !== null
    && issues.length < 15
  ) {
    const item = match[1];

    const title = readXmlValue(
      item,
      /<title>([\s\S]*?)<\/title>/,
    );

    const url = readXmlValue(
      item,
      /<link>([\s\S]*?)<\/link>/,
    );

    const source =
      readXmlValue(
        item,
        /<source[^>]*>([\s\S]*?)<\/source>/,
      )
      || 'Google News';

    const publishedAt = readXmlValue(
      item,
      /<pubDate>([\s\S]*?)<\/pubDate>/,
    );

    const key = title
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    if (
      !title
      || !url.startsWith('http')
      || duplicate.has(key)
    ) {
      continue;
    }

    duplicate.add(key);

    issues.push({
      title,
      url,
      source,
      publishedAt: safeIsoDate(publishedAt),
    });
  }

  return issues;
}

async function fetchRssQuery(
  market: NewsBriefingMarket,
  query: string,
): Promise<RawNewsIssue[]> {
  const config = MARKET_CONFIG[market];

  const url =
    'https://news.google.com/rss/search'
    + `?q=${encodeURIComponent(query)}`
    + `&hl=${encodeURIComponent(config.hl)}`
    + `&gl=${encodeURIComponent(config.gl)}`
    + `&ceid=${encodeURIComponent(config.ceid)}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `시장 뉴스 RSS 오류: ${response.status}`,
    );
  }

  return parseRss(
    await response.text(),
  );
}

async function fetchRss(
  market: NewsBriefingMarket,
): Promise<RawNewsIssue[]> {
  const queries = [
    MARKET_CONFIG[market].query,
    ...EXTRA_QUERIES[market],
  ];

  const settled = await Promise.allSettled(
    queries.map((query) =>
      fetchRssQuery(market, query),
    ),
  );

  const merged: RawNewsIssue[] = [];
  const seen = new Set<string>();

  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      console.error(
        `시장 뉴스 추가 검색 실패 (${market}):`,
        result.reason,
      );
      continue;
    }

    for (const issue of result.value) {
      const key = issue.title
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(issue);
    }
  }

  merged.sort(
    (left, right) =>
      new Date(right.publishedAt).getTime()
      - new Date(left.publishedAt).getTime(),
  );

  if (merged.length === 0) {
    throw new Error(
      `${MARKET_CONFIG[market].label} 뉴스를 찾지 못했습니다.`,
    );
  }

  return merged.slice(0, 15);
}

function isGoogleUrl(value: string): boolean {
  try {
    const host = new URL(value)
      .hostname
      .toLowerCase();

    return (
      host === 'news.google.com'
      || host.endsWith('.google.com')
      || host.endsWith('.google.co.kr')
      || host.endsWith('.gstatic.com')
      || host.endsWith('.googleusercontent.com')
    );
  } catch {
    return true;
  }
}

function isSafePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);

    if (
      url.protocol !== 'http:'
      && url.protocol !== 'https:'
    ) {
      return false;
    }

    const host = url.hostname.toLowerCase();

    return !(
      host === 'localhost'
      || host === '127.0.0.1'
      || host === '0.0.0.0'
      || host.startsWith('10.')
      || host.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

function resolveUrl(
  value: string,
  baseUrl: string,
): string | null {
  try {
    const resolved = new URL(
      decodeHtml(value),
      baseUrl,
    ).toString();

    return isSafePublicUrl(resolved)
      ? resolved
      : null;
  } catch {
    return null;
  }
}

function findPublisherUrl(
  html: string,
  baseUrl: string,
): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/gi,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/gi,
    /<a[^>]+href=["']([^"']+)["']/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;

    while (
      (match = pattern.exec(html)) !== null
    ) {
      const candidate = resolveUrl(
        match[1],
        baseUrl,
      );

      if (
        candidate
        && !isGoogleUrl(candidate)
      ) {
        return candidate;
      }
    }
  }

  const normalized = html
    .replace(/\\u003d/gi, '=')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');

  const urls =
    normalized.match(
      /https?:\/\/[^\s"'<>\\]+/g,
    )
    ?? [];

  for (const raw of urls) {
    const candidate = resolveUrl(
      raw.replace(/[),.;]+$/, ''),
      baseUrl,
    );

    if (
      candidate
      && !isGoogleUrl(candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

async function fetchHtml(
  url: string,
): Promise<{
  url: string;
  html: string;
}> {
  const response = await fetch(url, {
    redirect: 'follow',

    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',

      Accept:
        'text/html,application/xhtml+xml',
    },

    signal:
      AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    throw new Error(
      `기사 원문 오류: ${response.status}`,
    );
  }

  const contentType =
    response.headers.get('content-type')
    ?? '';

  if (
    !contentType.includes('text/html')
    && !contentType.includes('application/xhtml+xml')
  ) {
    throw new Error(
      '기사 원문이 HTML 형식이 아닙니다.',
    );
  }

  return {
    url: response.url,
    html: await response.text(),
  };
}

async function fetchReaderText(
  url: string,
): Promise<{
  url: string;
  body: string;
}> {
  const response = await fetch(
    `https://r.jina.ai/${url}`,
    {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(25_000),
    },
  );

  if (!response.ok) {
    throw new Error(
      `기사 리더 응답 오류: ${response.status}`,
    );
  }

  const raw = await response.text();

  const sourceMatch = raw.match(
    /^URL Source:\s*(https?:\/\/\S+)/mi,
  );

  const sourceUrl =
    sourceMatch?.[1]
    && isSafePublicUrl(sourceMatch[1])
    && !isGoogleUrl(sourceMatch[1])
      ? sourceMatch[1]
      : url;

  const body = raw
    .replace(
      /^(?:Title|URL Source|Published Time|Markdown Content):.*$/gmi,
      ' ',
    )
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*_`|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 9_000)
    .trim();

  return {
    url: sourceUrl,
    body,
  };
}

function extractArticleBody(
  html: string,
): string {
  const cleaned = html
    .replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/gi,
      ' ',
    )
    .replace(
      /<style\b[^>]*>[\s\S]*?<\/style>/gi,
      ' ',
    )
    .replace(
      /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
      ' ',
    )
    .replace(
      /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
      ' ',
    )
    .replace(
      /<nav\b[^>]*>[\s\S]*?<\/nav>/gi,
      ' ',
    )
    .replace(
      /<footer\b[^>]*>[\s\S]*?<\/footer>/gi,
      ' ',
    )
    .replace(
      /<header\b[^>]*>[\s\S]*?<\/header>/gi,
      ' ',
    );

  const article =
    cleaned.match(
      /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    )?.[1]
    ?? cleaned;

  const paragraphs = Array.from(
    article.matchAll(
      /<p\b[^>]*>([\s\S]*?)<\/p>/gi,
    ),
  )
    .map((match) =>
      stripTags(match[1]),
    )
    .filter((text) =>
      text.length >= 35,
    );

  const description =
    cleaned.match(
      /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i,
    )?.[1]
    ?? cleaned.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i,
    )?.[1]
    ?? '';

  return [
    stripTags(description),
    ...paragraphs,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 9_000)
    .trim();
}

async function fetchArticle(
  issue: RawNewsIssue,
  index: number,
): Promise<ArticleNewsIssue> {
  let articleUrl = issue.url;
  let body = '';

  try {
    const first = await fetchHtml(
      issue.url,
    );

    articleUrl = first.url;
    let articleHtml = first.html;

    if (isGoogleUrl(articleUrl)) {
      const publisherUrl =
        findPublisherUrl(
          first.html,
          first.url,
        );

      if (publisherUrl) {
        const publisher =
          await fetchHtml(publisherUrl);

        articleUrl = publisher.url;
        articleHtml = publisher.html;
      }
    }

    body = extractArticleBody(
      articleHtml,
    );
  } catch (error) {
    console.error(
      `기사 HTML 수집 실패 (${issue.source}):`,
      error,
    );
  }

  if (
    body.length < 120
    || isGoogleUrl(articleUrl)
  ) {
    const readerTargets = Array.from(
      new Set([
        articleUrl,
        issue.url,
      ]),
    );

    for (const target of readerTargets) {
      try {
        const reader =
          await fetchReaderText(target);

        if (reader.body.length > body.length) {
          body = reader.body;
        }

        if (
          !isGoogleUrl(reader.url)
          && isSafePublicUrl(reader.url)
        ) {
          articleUrl = reader.url;
        }

        if (body.length >= 120) {
          break;
        }
      } catch (error) {
        console.error(
          `기사 리더 수집 실패 (${issue.source}):`,
          error,
        );
      }
    }
  }

  return {
    ...issue,
    index,

    articleUrl:
      !isGoogleUrl(articleUrl)
      && isSafePublicUrl(articleUrl)
        ? articleUrl
        : issue.url,

    body:
      body.length >= 120
        ? body
        : '',
  };
}

function fallbackItemSummary(
  body: string,
): string {
  if (!body) {
    return '기사 원문을 불러오지 못해 이번 AI 종합 분석에서 제외했습니다.';
  }

  const sentences = body
    .split(/[.!?。]\s+|다\.\s+/)
    .map((value) => value.trim())
    .filter((value) =>
      value.length >= 25,
    );

  return (
    sentences.slice(0, 2).join(' ')
    || body
  )
    .slice(0, 260)
    .trim();
}

function extractOpenAiText(
  payload: any,
): string {
  if (
    typeof payload?.output_text === 'string'
  ) {
    return payload.output_text;
  }

  const values: string[] = [];

  for (
    const output of payload?.output ?? []
  ) {
    for (
      const content of output?.content ?? []
    ) {
      if (
        typeof content?.text === 'string'
      ) {
        values.push(content.text);
      }
    }
  }

  return values.join('\n').trim();
}

function parseJsonResponse(
  value: string,
): any {
  const cleaned = value
    .replace(
      /^```(?:json)?\s*/i,
      '',
    )
    .replace(
      /\s*```$/i,
      '',
    )
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (
    start < 0
    || end <= start
  ) {
    throw new Error(
      'AI 분석 JSON을 찾지 못했습니다.',
    );
  }

  return JSON.parse(
    cleaned.slice(start, end + 1),
  );
}

async function analyzeWithOpenAi(
  market: NewsBriefingMarket,
  articles: ArticleNewsIssue[],
): Promise<AiAnalysis> {
  const apiKey =
    process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY가 없습니다.',
    );
  }

  const available = articles.filter(
    (article) =>
      article.body.length >= 120,
  );

  if (available.length < 1) {
    throw new Error(
      '분석 가능한 기사 원문이 부족합니다.',
    );
  }

  const model =
    process.env.OPENAI_MARKET_BRIEFING_MODEL?.trim()
    || process.env.OPENAI_REPAIR_MODEL?.trim()
    || 'gpt-5.1';

  const articleBodies = available
    .map(
      (article) =>
        `${article.index}번 기사\n`
        + `출처: ${article.source}\n`
        + `원문 본문:\n${article.body}`,
    )
    .join('\n\n');

  const prompt = `
당신은 한국어 금융시장 뉴스 분석가입니다.
분석 시장은 ${MARKET_CONFIG[market].label}입니다.

아래 뉴스의 제목을 나열하거나 바꿔 쓰지 말고
각 뉴스의 실제 원문 본문을 서로 연결해서
오늘 시장의 구체적인 원인과 파급효과를 분석하세요.

반드시 지킬 규칙:

1. “긍정과 경계 요인이 함께 나타납니다” 같은 고정 문구를 사용하지 마세요.
2. “정책, 금리, 실적, 규제를 중심으로 형성되었습니다” 같은 일반 문구로 통일하지 마세요.
3. 기사 본문에 등장한 실제 기업, 업종, 정책, 수급, 매수와 매도 원인을 구체적으로 언급하세요.
4. 예를 들어 AI·반도체 투자 확대가 삼성전자와 관련 업종에 주는 영향이나 대형주 매도가 코스피와 코스닥 투자심리에 미치는 영향을 기사 근거로 연결하세요.
5. 지수 등락률이나 퍼센트만 보고 시장을 판단하지 마세요.
6. 확인되지 않은 사실은 만들지 마세요.
7. 각 기사 요약은 기사 제목을 복사하지 말고 본문 핵심과 시장 영향을 한 문장으로 작성하세요.
8. 모든 내용은 한국어로 작성하세요.

아래 JSON 형식만 출력하세요.

{
  "stance": "강세 또는 중립 또는 약세",
  "headline": "뉴스 원문 전체를 종합한 오늘 시장의 구체적인 핵심 결론",
  "summary": "기사 원문들의 관계를 연결한 오늘 시장 분석 3~5문장",
  "items": [
    {
      "index": 1,
      "summary": "1번 기사 본문의 핵심 원인과 시장 영향"
    },
    {
      "index": 2,
      "summary": "2번 기사 본문의 핵심 원인과 시장 영향"
    },
    {
      "index": 3,
      "summary": "3번 기사 본문의 핵심 원인과 시장 영향"
    },
    {
      "index": 4,
      "summary": "4번 기사 본문의 핵심 원인과 시장 영향"
    },
    {
      "index": 5,
      "summary": "5번 기사 본문의 핵심 원인과 시장 영향"
    }
  ]
}

뉴스 원문:

${articleBodies}
`.trim();

  const response = await fetch(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',

      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },

      body: JSON.stringify({
        model,
        input: prompt,
        max_output_tokens: 1_600,
      }),

      signal:
        AbortSignal.timeout(45_000),
    },
  );

  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => '');

    throw new Error(
      `AI 뉴스 분석 오류: ${response.status} ${errorText.slice(0, 200)}`,
    );
  }

  const parsed = parseJsonResponse(
    extractOpenAiText(
      await response.json(),
    ),
  );

  const stance: NewsStance =
    parsed.stance === '강세'
    || parsed.stance === '약세'
      ? parsed.stance
      : '중립';

  const summaries =
    new Map<number, string>();

  if (Array.isArray(parsed.items)) {
    for (const item of parsed.items) {
      const index = Number(
        item?.index,
      );

      const summary = String(
        item?.summary ?? '',
      ).trim();

      if (
        Number.isInteger(index)
        && index >= 1
        && index <= 5
        && summary
      ) {
        summaries.set(
          index,
          summary,
        );
      }
    }
  }

  return {
    stance,

    headline:
      String(
        parsed.headline ?? '',
      ).trim()
      || `${MARKET_CONFIG[market].label} 뉴스 원문 분석`,

    summary:
      String(
        parsed.summary ?? '',
      ).trim()
      || '수집된 기사 원문을 종합해 오늘 시장 흐름을 분석했습니다.',

    itemSummaries:
      articles.map(
        (article) =>
          summaries.get(article.index)
          || fallbackItemSummary(article.body),
      ),
  };
}

function fallbackAnalysis(
  market: NewsBriefingMarket,
  articles: ArticleNewsIssue[],
): AiAnalysis {
  const itemSummaries = articles.map(
    (article) =>
      fallbackItemSummary(article.body),
  );

  const usable = itemSummaries.filter(
    (summary) =>
      !summary.startsWith(
        '기사 원문을 불러오지 못해',
      ),
  );

  return {
    stance: '중립',

    headline:
      usable[0]
      || `${MARKET_CONFIG[market].label} 기사 원문을 불러오는 중입니다.`,

    summary:
      usable.slice(0, 3).join(' ')
      || '기사 제공기관에서 원문 본문을 불러오는 중입니다.',

    itemSummaries,
  };
}

async function getBriefing(
  market: NewsBriefingMarket,
): Promise<MarketNewsBriefing> {
  const cached = cache.get(market);

  if (
    cached
    && cached.expiresAt > Date.now()
  ) {
    return cached.data;
  }

  const news = await fetchRss(market);

  const selected =
    news.slice(0, 5);

  const articles =
    await Promise.all(
      selected.map(
        (issue, index) =>
          fetchArticle(
            issue,
            index + 1,
          ),
      ),
    );

  let analysis: AiAnalysis;
  let aiUsed = false;

  try {
    analysis =
      await analyzeWithOpenAi(
        market,
        articles,
      );

    aiUsed = true;
  } catch (error) {
    console.error(
      `시장 뉴스 AI 분석 대체 처리 (${market}):`,
      error,
    );

    analysis =
      fallbackAnalysis(
        market,
        articles,
      );
  }

  const result: MarketNewsBriefing = {
    market,
    asOf: new Date().toISOString(),
    stance: analysis.stance,
    headline: analysis.headline,
    summary: analysis.summary,
    reasons: [],

    issues: articles.map(
      (article, index) => ({
        title: article.title,
        url:
          article.articleUrl
          || article.url,
        source: article.source,
        publishedAt: article.publishedAt,

        summary:
          analysis.itemSummaries[index]
          || fallbackItemSummary(
            article.body,
          ),
      }),
    ),

    aiUsed,
  };

  cache.set(market, {
    expiresAt:
      Date.now() + CACHE_MS,

    data: result,
  });

  return result;
}

export const MarketNewsBriefingService = {
  getBriefing,
};
