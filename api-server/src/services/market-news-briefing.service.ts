import { fetchText } from '../lib/http';

export type NewsBriefingMarket = 'KR' | 'US' | 'COIN';
type Stance = '강세' | '중립' | '약세';

export interface MarketNewsIssue {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
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

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<NewsBriefingMarket, { expiresAt: number; value: MarketNewsBriefing }>();

const QUERIES: Record<NewsBriefingMarket, { query: string; hl: string; gl: string; ceid: string; label: string }> = {
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

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function pick(block: string, pattern: RegExp): string {
  const match = block.match(pattern);
  return match ? decodeXml(match[1]) : '';
}

function parseIssues(xml: string): MarketNewsIssue[] {
  const issues: MarketNewsIssue[] = [];
  const seen = new Set<string>();
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null && issues.length < 12) {
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

async function fetchIssues(market: NewsBriefingMarket): Promise<MarketNewsIssue[]> {
  const config = QUERIES[market];
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(config.query)}&hl=${config.hl}&gl=${config.gl}&ceid=${config.ceid}`;
  const xml = await fetchText(url, {
    provider: 'google-market-news',
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  return parseIssues(xml);
}

const POSITIVE = [
  '지원', '완화', '인하', '회복', '성장', '호실적', '수주', '확대', '승인', '개선', '강세',
  'rally', 'growth', 'beat', 'beats', 'record', 'approval', 'cut rates', 'easing', 'recovery',
];

const NEGATIVE = [
  '긴축', '인상', '규제', '우려', '충돌', '전쟁', '제재', '부진', '감소', '리스크', '약세',
  'probe', 'lawsuit', 'war', 'sanction', 'inflation', 'tightening', 'recession', 'miss', 'downgrade',
];

function keywordScore(issues: MarketNewsIssue[]): number {
  const text = issues.map((issue) => issue.title.toLowerCase()).join(' ');
  const positive = POSITIVE.reduce((score, word) => score + (text.includes(word.toLowerCase()) ? 1 : 0), 0);
  const negative = NEGATIVE.reduce((score, word) => score + (text.includes(word.toLowerCase()) ? 1 : 0), 0);
  return positive - negative;
}

function fallbackAnalysis(market: NewsBriefingMarket, issues: MarketNewsIssue[]): Omit<MarketNewsBriefing, 'market' | 'asOf' | 'issues' | 'aiUsed'> {
  const label = QUERIES[market].label;
  const score = keywordScore(issues);
  const stance: Stance = score >= 2 ? '강세' : score <= -2 ? '약세' : '중립';
  const titles = issues.slice(0, 3).map((issue) => issue.title);

  const headline =
    stance === '강세'
      ? `${label}는 오늘 뉴스 흐름에서 긍정 요인이 우세합니다.`
      : stance === '약세'
        ? `${label}는 오늘 뉴스 흐름에서 경계 요인이 우세합니다.`
        : `${label}는 긍정과 경계 요인이 함께 나타나는 혼조 흐름입니다.`;

  return {
    stance,
    headline,
    summary: issues.length
      ? `오늘 수집된 주요 뉴스는 정책, 금리, 기업 실적, 규제와 산업 이슈를 중심으로 형성되어 있습니다. 단순 지수 등락이 아니라 뉴스의 원인과 파급 가능성을 기준으로 보면 현재 분위기는 ${stance} 쪽으로 분석됩니다.`
      : '오늘 분석할 수 있는 주요 뉴스가 아직 충분히 수집되지 않았습니다.',
    reasons: titles.length
      ? titles.map((title) => `주요 보도: ${title}`)
      : ['뉴스 공급기관에서 새로운 시장 이슈를 확인하는 중입니다.'],
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
  issues: MarketNewsIssue[],
): Promise<Omit<MarketNewsBriefing, 'market' | 'asOf' | 'issues' | 'aiUsed'>> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY가 없습니다.');

  const model =
    process.env.OPENAI_MARKET_BRIEFING_MODEL?.trim() ||
    process.env.OPENAI_REPAIR_MODEL?.trim() ||
    'gpt-5.1';

  const newsText = issues
    .slice(0, 12)
    .map((issue, index) => `${index + 1}. [${issue.source}] ${issue.title}`)
    .join('\n');

  const prompt = `
당신은 한국어 금융 뉴스 브리핑 분석가입니다.
분석 대상: ${QUERIES[market].label}

아래의 실제 주요 뉴스 제목과 출처만 근거로 오늘의 시장 이슈를 분석하세요.
가격, 등락률, 퍼센트, 지수 수치만으로 강세·약세를 판단하면 안 됩니다.
정책, 금리, 환율, 기업 실적, 규제, 지정학, 산업 수요, 투자심리의 원인과 파급효과를 종합하세요.
과장하거나 확정적으로 예측하지 말고, 뉴스에서 확인되지 않은 사실은 만들지 마세요.

반드시 아래 JSON 형식만 출력하세요.
{
  "stance": "강세 또는 중립 또는 약세",
  "headline": "오늘의 핵심 결론 한 문장",
  "summary": "오늘은 어떤 뉴스들이 있어서 시장이 어떻게 분석되는지 3~5문장",
  "reasons": ["핵심 이유 1", "핵심 이유 2", "핵심 이유 3"]
}

뉴스:
${newsText}
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
      max_output_tokens: 700,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`시장 뉴스 AI 분석 실패: ${response.status} ${message.slice(0, 200)}`);
  }

  const payload = await response.json();
  const parsed = parseJsonText(extractResponseText(payload));
  const stance: Stance = parsed.stance === '강세' || parsed.stance === '약세' ? parsed.stance : '중립';
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.map((value: unknown) => String(value).trim()).filter(Boolean).slice(0, 4)
    : [];

  return {
    stance,
    headline: String(parsed.headline ?? '').trim() || `${QUERIES[market].label} 뉴스 브리핑`,
    summary: String(parsed.summary ?? '').trim() || '주요 뉴스 흐름을 분석했습니다.',
    reasons,
  };
}

async function getBriefing(market: NewsBriefingMarket): Promise<MarketNewsBriefing> {
  const cached = cache.get(market);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const issues = await fetchIssues(market);
  let analysis: Omit<MarketNewsBriefing, 'market' | 'asOf' | 'issues' | 'aiUsed'>;
  let aiUsed = false;

  try {
    if (issues.length < 2) throw new Error('분석할 뉴스가 충분하지 않습니다.');
    analysis = await analyzeWithAi(market, issues);
    aiUsed = true;
  } catch (error) {
    console.error(`market news AI briefing fallback (${market}):`, error);
    analysis = fallbackAnalysis(market, issues);
  }

  const value: MarketNewsBriefing = {
    market,
    asOf: new Date().toISOString(),
    ...analysis,
    issues,
    aiUsed,
  };

  cache.set(market, { expiresAt: Date.now() + CACHE_MS, value });
  return value;
}

export const MarketNewsBriefingService = {
  getBriefing,
};
