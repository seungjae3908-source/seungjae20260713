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

interface LocalTermGroup {
  label: string;
  words: string[];
  impact: string;
}

const LOCAL_ENTITY_GROUPS: LocalTermGroup[] = [
  {
    label: '삼성전자',
    words: ['삼성전자', 'samsung electronics'],
    impact:
      '삼성전자 관련 실적·투자·수급 뉴스가 반도체 대형주와 코스피 흐름에 영향을 주고 있습니다.',
  },
  {
    label: 'SK하이닉스',
    words: ['sk하이닉스', 'sk hynix', '하이닉스'],
    impact:
      'SK하이닉스 관련 HBM·메모리 수요 뉴스가 반도체 장비·부품주 투자심리에 연결되고 있습니다.',
  },
  {
    label: '현대차·기아',
    words: ['현대차', '현대자동차', '기아', 'hyundai motor', 'kia'],
    impact:
      '현대차·기아의 판매·실적·정책 이슈가 자동차와 부품주 흐름에 영향을 주고 있습니다.',
  },
  {
    label: '엔비디아',
    words: ['엔비디아', 'nvidia'],
    impact:
      '엔비디아 관련 AI 수요와 공급망 뉴스가 글로벌 반도체 및 기술주 투자심리를 움직이고 있습니다.',
  },
  {
    label: '테슬라',
    words: ['테슬라', 'tesla'],
    impact:
      '테슬라의 판매·실적·정책 뉴스가 전기차와 이차전지 관련 종목의 기대와 부담을 함께 바꾸고 있습니다.',
  },
  {
    label: '비트코인',
    words: ['비트코인', 'bitcoin', 'btc'],
    impact:
      '비트코인 관련 자금 유입·규제·ETF 뉴스가 코인 시장의 위험선호에 직접 영향을 주고 있습니다.',
  },
  {
    label: '이더리움',
    words: ['이더리움', 'ethereum', 'eth'],
    impact:
      '이더리움 관련 네트워크·ETF·규제 뉴스가 알트코인 전반의 투자심리에 연결되고 있습니다.',
  },
];

const LOCAL_THEME_GROUPS: LocalTermGroup[] = [
  {
    label: 'AI·반도체',
    words: [
      '인공지능',
      'ai ',
      'ai·',
      '반도체',
      'hbm',
      '메모리',
      '파운드리',
      '데이터센터',
      'chip',
      'semiconductor',
    ],
    impact:
      'AI·반도체 투자와 실적 기대가 관련 대형주와 장비·부품주 관심을 높이는 흐름입니다.',
  },
  {
    label: '외국인·기관 매도 수급',
    words: [
      '외국인 매도',
      '기관 매도',
      '순매도',
      '매도세',
      '차익 실현',
      '차익실현',
      'sell-off',
      'net selling',
    ],
    impact:
      '외국인·기관 매도와 차익실현 언급은 대형주 수급 및 코스피·코스닥 투자심리에 부담으로 작용할 수 있습니다.',
  },
  {
    label: '매수·자금 유입',
    words: [
      '순매수',
      '매수세',
      '자금 유입',
      '수급 개선',
      '저가 매수',
      'inflow',
      'buying',
    ],
    impact:
      '매수세와 자금 유입은 관련 업종의 거래 집중과 단기 투자심리 개선으로 이어지고 있습니다.',
  },
  {
    label: '금리·통화정책',
    words: [
      '기준금리',
      '금리 인하',
      '금리 동결',
      '금리 인상',
      '연준',
      '한국은행',
      'fed',
      'federal reserve',
      'interest rate',
    ],
    impact:
      '금리와 통화정책 기대 변화가 성장주 가치평가, 환율, 외국인 수급에 영향을 주고 있습니다.',
  },
  {
    label: '환율·달러',
    words: [
      '환율',
      '원달러',
      '원·달러',
      '달러 강세',
      '달러 약세',
      'exchange rate',
      'dollar',
    ],
    impact:
      '원·달러 환율과 달러 방향은 외국인 수급 및 수출주·성장주의 상대적인 강도에 영향을 주고 있습니다.',
  },
  {
    label: '기업 실적',
    words: [
      '실적',
      '영업이익',
      '매출',
      '어닝',
      'earnings',
      'revenue',
      'operating profit',
    ],
    impact:
      '기업 실적과 전망 변화가 종목별 차별화를 키우면서 지수보다 개별 업종 반응이 커지고 있습니다.',
  },
  {
    label: '정책·규제',
    words: [
      '정책',
      '규제',
      '관세',
      '보조금',
      '법안',
      '승인',
      'regulation',
      'tariff',
      'subsidy',
      'approval',
    ],
    impact:
      '정책·규제 변화가 관련 산업의 비용, 투자계획, 수익성 기대를 다시 평가하게 만들고 있습니다.',
  },
  {
    label: '자동차·전기차',
    words: [
      '자동차',
      '전기차',
      '이차전지',
      '배터리',
      'vehicle',
      'electric vehicle',
      'battery',
    ],
    impact:
      '자동차·전기차 수요와 정책 뉴스가 완성차, 부품, 배터리 종목의 흐름을 나누고 있습니다.',
  },
  {
    label: '코스피·코스닥 수급',
    words: [
      '코스피',
      '코스닥',
      '대형주',
      '중소형주',
      'kospi',
      'kosdaq',
    ],
    impact:
      '코스피 대형주와 코스닥 성장주의 수급 차이가 시장 체감 강도와 종목별 변동성을 키우고 있습니다.',
  },
  {
    label: '가상자산 ETF·규제',
    words: [
      '현물 etf',
      '비트코인 etf',
      '이더리움 etf',
      '가상자산 규제',
      '암호화폐 규제',
      'crypto etf',
    ],
    impact:
      '가상자산 ETF와 규제 뉴스가 기관 자금 유입 기대와 거래소·알트코인 위험을 동시에 바꾸고 있습니다.',
  },
];

const LOCAL_POSITIVE_WORDS = [
  '상승',
  '강세',
  '개선',
  '증가',
  '확대',
  '회복',
  '호실적',
  '수주',
  '승인',
  '지원',
  '완화',
  '순매수',
  '자금 유입',
  'growth',
  'beat',
  'record',
  'approval',
  'recovery',
  'inflow',
  'rally',
];

const LOCAL_NEGATIVE_WORDS = [
  '하락',
  '약세',
  '감소',
  '부진',
  '우려',
  '위축',
  '규제 강화',
  '매도세',
  '순매도',
  '차익실현',
  '리스크',
  '긴축',
  'sell-off',
  'miss',
  'downgrade',
  'recession',
  'tightening',
  'risk',
];

function countLocalWord(
  text: string,
  word: string,
): number {
  const normalizedText = text.toLowerCase();
  const normalizedWord = word.toLowerCase();

  if (!normalizedWord) {
    return 0;
  }

  return Math.max(
    0,
    normalizedText.split(normalizedWord).length - 1,
  );
}

function scoreLocalWords(
  text: string,
  words: string[],
): number {
  return words.reduce(
    (total, word) =>
      total + countLocalWord(text, word),
    0,
  );
}

function rankedLocalGroups(
  text: string,
  groups: LocalTermGroup[],
  limit: number,
): Array<LocalTermGroup & { score: number }> {
  return groups
    .map((group) => ({
      ...group,
      score: scoreLocalWords(text, group.words),
    }))
    .filter((group) => group.score > 0)
    .sort((left, right) =>
      right.score - left.score,
    )
    .slice(0, limit);
}

function localArticleSummary(
  article: ArticleNewsIssue,
): string {
  if (!article.body) {
    return '기사 제공기관에서 원문 본문을 불러오는 중입니다.';
  }

  const sentences = article.body
    .split(/[.!?。]\s+|다\.\s+/)
    .map((value, order) => ({
      value: value.trim(),
      order,
    }))
    .filter((item) =>
      item.value.length >= 30,
    );

  if (sentences.length === 0) {
    return article.body.slice(0, 260).trim();
  }

  const keywords = [
    ...LOCAL_ENTITY_GROUPS.flatMap((group) => group.words),
    ...LOCAL_THEME_GROUPS.flatMap((group) => group.words),
    ...LOCAL_POSITIVE_WORDS,
    ...LOCAL_NEGATIVE_WORDS,
  ];

  const selected = sentences
    .map((item) => ({
      ...item,
      score:
        scoreLocalWords(item.value, keywords)
        + (item.order < 3 ? 2 : 0),
    }))
    .sort((left, right) =>
      right.score - left.score
      || left.order - right.order,
    )
    .slice(0, 2)
    .sort((left, right) =>
      left.order - right.order,
    )
    .map((item) => item.value);

  return selected
    .join(' ')
    .slice(0, 280)
    .trim();
}

function localBodyAnalysis(
  market: NewsBriefingMarket,
  articles: ArticleNewsIssue[],
): AiAnalysis {
  const available = articles.filter(
    (article) => article.body.length >= 80,
  );

  const combined = available
    .map((article) => article.body)
    .join(' ');

  const entities = rankedLocalGroups(
    combined,
    LOCAL_ENTITY_GROUPS,
    3,
  );

  const themes = rankedLocalGroups(
    combined,
    LOCAL_THEME_GROUPS,
    3,
  );

  const positiveScore =
    scoreLocalWords(
      combined,
      LOCAL_POSITIVE_WORDS,
    );

  const negativeScore =
    scoreLocalWords(
      combined,
      LOCAL_NEGATIVE_WORDS,
    );

  const stance: NewsStance =
    positiveScore >= negativeScore + 3
      ? '강세'
      : negativeScore >= positiveScore + 3
        ? '약세'
        : '중립';

  const entityText = entities
    .map((item) => item.label)
    .join('·');

  const themeText = themes
    .map((item) => item.label)
    .join('·');

  const subject =
    entityText
    || themeText
    || MARKET_CONFIG[market].label;

  const headline =
    themes.length > 0
      ? `${subject} 관련 원문 뉴스와 ${themes[0].label} 이슈가 오늘 ${MARKET_CONFIG[market].label} 흐름의 핵심으로 나타났습니다.`
      : `${MARKET_CONFIG[market].label} 기사 원문에서 확인된 기업·산업 이슈를 기준으로 시장 흐름을 분석했습니다.`;

  const summaryParts: string[] = [];

  if (entities.length > 0) {
    summaryParts.push(
      `기사 원문에서 ${entityText} 관련 내용이 반복적으로 확인됐습니다.`,
    );
  }

  for (const theme of themes) {
    summaryParts.push(theme.impact);
  }

  if (positiveScore > negativeScore) {
    summaryParts.push(
      '원문에 나타난 개선·확대·자금 유입 표현이 부담 요인보다 많아 뉴스 흐름은 상대적으로 우호적입니다.',
    );
  } else if (negativeScore > positiveScore) {
    summaryParts.push(
      '원문에 나타난 매도·부진·규제·위축 표현이 호재보다 많아 관련 종목과 시장 투자심리에 부담이 확인됩니다.',
    );
  } else {
    summaryParts.push(
      '원문에서 호재와 부담 요인이 비슷하게 확인돼 업종과 종목별 차별화가 큰 흐름입니다.',
    );
  }

  if (available.length < 2) {
    summaryParts.push(
      '현재 불러온 기사 원문이 적어 추가 뉴스가 수집되면 분석 내용이 자동으로 보완됩니다.',
    );
  }

  return {
    stance,
    headline,
    summary: summaryParts
      .slice(0, 5)
      .join(' '),
    itemSummaries: articles.map(
      (article) =>
        localArticleSummary(article),
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

  const analysis =
    localBodyAnalysis(
      market,
      articles,
    );

  const aiUsed = false;

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
