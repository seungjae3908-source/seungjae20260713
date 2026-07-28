// 오늘의 이슈: 실제 뉴스(Google News RSS)와 실제 지수 데이터만 사용한다.
// 가짜 요약·가짜 링크를 만들지 않는다. 링크가 없으면 url을 null로 남긴다.
import { cached } from '../lib/cache';
import { fetchText } from '../lib/http';
import { MarketDataService } from './market-data.service';

export interface MarketIssueItem {
  title: string;
  summary: string;          // 핵심 요약 (RSS 설명 또는 제목 기반)
  impact: '긍정적' | '부정적' | '중립'; // 시장 영향 (키워드 기반 추정)
  related: string[];        // 관련 시장 또는 종목 키워드
  source: string;           // 뉴스 출처 (언론사)
  publishedAt: string | null; // 작성 시각 (ISO)
  url: string | null;       // 원본 링크 (없으면 null = 출처 확인 불가)
}

export interface MarketIssuesResult {
  ok: boolean;
  overview: string | null;  // 시장 종합요약 1개 (실제 지수 수치 기반)
  issues: MarketIssueItem[]; // 최대 5개
  updatedAt: string;
}

const REFRESH_MS = 5 * 60 * 1000;

const POS_KO = ['상승', '급등', '호실적', '최대', '수주', '흑자', '성장', '돌파', '신고가', '상향', '개선', '호재', '강세', '반등', '기대'];
const NEG_KO = ['하락', '급락', '적자', '감소', '하향', '손실', '우려', '약세', '유상증자', '악재', '부진', '리스크', '경고', '침체', '충격'];

const RELATED_KEYWORDS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /코스피|kospi/i, label: '코스피' },
  { pattern: /코스닥|kosdaq/i, label: '코스닥' },
  { pattern: /나스닥|nasdaq/i, label: '나스닥' },
  { pattern: /s&p|에스앤피/i, label: 'S&P 500' },
  { pattern: /다우/i, label: '다우' },
  { pattern: /비트코인|bitcoin|btc/i, label: '비트코인' },
  { pattern: /이더리움|ethereum|eth\b/i, label: '이더리움' },
  { pattern: /반도체|삼성전자|하이닉스/i, label: '반도체' },
  { pattern: /환율|원\/달러|원달러/i, label: '환율' },
  { pattern: /금리|연준|한국은행|fomc/i, label: '금리' },
  { pattern: /유가|국제유가|wti/i, label: '유가' },
];

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function pick(block: string, re: RegExp): string {
  const m = block.match(re);
  return m ? m[1] : '';
}

function impactOf(text: string): MarketIssueItem['impact'] {
  const pos = POS_KO.filter((w) => text.includes(w)).length;
  const neg = NEG_KO.filter((w) => text.includes(w)).length;
  if (pos > neg) return '긍정적';
  if (neg > pos) return '부정적';
  return '중립';
}

function relatedOf(text: string): string[] {
  return RELATED_KEYWORDS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label).slice(0, 3);
}

/** 제목 정규화로 중복 뉴스 제거용 키 생성. */
function dedupeKey(title: string): string {
  return title.replace(/\s+/g, '').replace(/[\[\](){}"'…·\-–—|,.]/g, '').slice(0, 40);
}

async function fetchIssuesFromRss(query: string): Promise<MarketIssueItem[]> {
  const xml = await fetchText(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`,
    { provider: 'google-news', headers: { 'User-Agent': 'Mozilla/5.0' } },
  );
  const items: MarketIssueItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && items.length < 20) {
    const block = m[1];
    const title = decodeXml(pick(block, /<title>([\s\S]*?)<\/title>/));
    const url = decodeXml(pick(block, /<link>([\s\S]*?)<\/link>/));
    const pub = pick(block, /<pubDate>([\s\S]*?)<\/pubDate>/);
    const srcName = decodeXml(pick(block, /<source[^>]*>([\s\S]*?)<\/source>/));
    const rawDesc = decodeXml(pick(block, /<description>([\s\S]*?)<\/description>/)).replace(/<[^>]*>/g, '').trim();
    if (!title) continue;

    const publishedAt = pub && !Number.isNaN(new Date(pub).getTime()) ? new Date(pub).toISOString() : null;
    const text = `${title} ${rawDesc}`;
    items.push({
      title,
      summary: rawDesc && rawDesc !== title ? rawDesc.slice(0, 160) : title,
      impact: impactOf(text),
      related: relatedOf(text),
      source: srcName || '출처 확인 불가',
      publishedAt,
      url: url && url.startsWith('http') ? url : null,
    });
  }
  return items;
}

function formatPct(v: number): string {
  const s = v >= 0 ? '+' : '';
  return `${s}${(Math.round(v * 100) / 100).toFixed(2)}%`;
}

/** 실제 지수 수치로만 만드는 시장 종합요약 (추측·전망 문구 없음). */
async function buildOverview(): Promise<string | null> {
  try {
    const items = await MarketDataService.getMarketSummary();
    const byKey = new Map(items.filter((i) => i.ok && Number(i.price) > 0).map((i) => [i.key, i]));
    const parts: string[] = [];
    for (const key of ['kospi', 'kosdaq', 'nasdaq', 'sp500', 'dow', 'btc'] as const) {
      const row = byKey.get(key);
      if (!row || !Number.isFinite(Number(row.changePercent))) continue;
      parts.push(`${row.label} ${formatPct(Number(row.changePercent))}`);
    }
    if (!parts.length) return null;
    return `${parts.join(' · ')} (실시간 지수 기준)`;
  } catch {
    return null;
  }
}

async function getMarketIssues(): Promise<MarketIssuesResult> {
  return cached('market-issues:v1', REFRESH_MS, async () => {
    const [overview, kr, coin] = await Promise.all([
      buildOverview(),
      fetchIssuesFromRss('증시 코스피 코스닥').catch(() => [] as MarketIssueItem[]),
      fetchIssuesFromRss('비트코인 시세').catch(() => [] as MarketIssueItem[]),
    ]);

    // 증시 뉴스 위주 + 코인 1개까지, 제목 기준 중복 제거 후 정확히 5개(부족하면 실제 개수만).
    const seen = new Set<string>();
    const issues: MarketIssueItem[] = [];
    const pushUnique = (item: MarketIssueItem) => {
      const key = dedupeKey(item.title);
      if (!key || seen.has(key)) return;
      seen.add(key);
      issues.push(item);
    };
    for (const item of kr) {
      if (issues.length >= 4) break;
      pushUnique(item);
    }
    for (const item of coin) {
      if (issues.length >= 5) break;
      pushUnique(item);
    }
    for (const item of kr.slice(4)) {
      if (issues.length >= 5) break;
      pushUnique(item);
    }

    return {
      ok: overview != null || issues.length > 0,
      overview,
      issues: issues.slice(0, 5),
      updatedAt: new Date().toISOString(),
    };
  });
}

export const MarketIssuesService = { getMarketIssues };
