// NewsService — live company news.
//
// US -> Finnhub company-news (by ticker)
// KR -> Google News RSS searched by Korean company NAME (never the 6-digit
//       code), which is how Korean outlets index coverage.
//
// Items without a real http(s) URL are dropped (cards must open a real
// article). On live failure we fall back to the deterministic sample feed.
import { getCatalogEntry, type CatalogEntry } from '../data/catalog';
import { getCompanyNews } from '../providers/finnhub';
import { fetchText } from '../lib/http';
import type { NewsData, NewsItem } from '../sample/types';

type Tone = 'positive' | 'negative';

function dateFromUnix(value?: number): string {
  if (!value) return new Date().toISOString().slice(0, 10);
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function domainFromUrl(url?: string): string {
  if (!url) return 'news.google.com';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'news.google.com';
  }
}

const POS_EN = [
  'beat', 'beats', 'surge', 'rise', 'gain', 'growth',
  'upgrade', 'strong', 'record', 'profit', 'buy', 'jump', 'soar',
];
const NEG_EN = [
  'miss', 'fall', 'drop', 'loss', 'lawsuit', 'probe',
  'downgrade', 'weak', 'sell', 'offering', 'dilution', 'plunge', 'cut',
];
const POS_KO = [
  '상승', '급등', '호실적', '최대', '수주', '흑자', '성장', '돌파',
  '신고가', '상향', '매수', '개선', '호재', '강세', '기대',
];
const NEG_KO = [
  '하락', '급락', '적자', '감소', '하향', '손실', '우려', '약세',
  '매도', '유상증자', '횡령', '악재', '부진', '리스크', '경고',
];

function toneFromText(text: string, kr: boolean): Tone {
  const lower = text.toLowerCase();
  const pos = (kr ? POS_KO : POS_EN).filter((w) => lower.includes(w.toLowerCase())).length;
  const neg = (kr ? NEG_KO : NEG_EN).filter((w) => lower.includes(w.toLowerCase())).length;
  return pos >= neg ? 'positive' : 'negative';
}

function splitNews(items: NewsItem[]): NewsData {
  const positive = items.filter((n) => n.tone === 'positive');
  const negative = items.filter((n) => n.tone === 'negative');
  const pos = positive.length ? positive : items.slice(0, Math.ceil(items.length / 2));
  const neg = negative.length ? negative : items.slice(Math.ceil(items.length / 2));
  const total = pos.length + neg.length || 1;
  return {
    positive: pos,
    negative: neg,
    sentimentScore: Math.round(((pos.length - neg.length) / total) * 100),
  };
}

async function usItems(entry: CatalogEntry): Promise<NewsItem[]> {
  const raw = await getCompanyNews(entry);
  return raw
    .filter((n) => n.headline && n.url && n.url.startsWith('http'))
    .slice(0, 14)
    .map((n) => {
      const tone = toneFromText(`${n.headline} ${n.summary}`, false);
      return {
        title: n.headline,
        source: n.source || domainFromUrl(n.url),
        sourceDomain: domainFromUrl(n.url),
        date: dateFromUnix(n.datetime),
        url: n.url,
        tone,
      } as NewsItem;
    });
}

// --- Google News RSS (KR) ---------------------------------------------------

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

async function krItems(entry: CatalogEntry): Promise<NewsItem[]> {
  const query = encodeURIComponent(`${entry.name} 주가`);
  const xml = await fetchText(
    `https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`,
    { provider: 'google-news', headers: { 'User-Agent': 'Mozilla/5.0' } },
  );

  const items: NewsItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && items.length < 16) {
    const block = m[1];
    const title = decodeXml(pick(block, /<title>([\s\S]*?)<\/title>/));
    const url = decodeXml(pick(block, /<link>([\s\S]*?)<\/link>/));
    const pub = pick(block, /<pubDate>([\s\S]*?)<\/pubDate>/);
    const srcUrl = pick(block, /<source[^>]*url="([^"]*)"/);
    const srcName = decodeXml(pick(block, /<source[^>]*>([\s\S]*?)<\/source>/));
    if (!title || !url || !url.startsWith('http')) continue;

    const date = pub ? new Date(pub).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    items.push({
      title,
      source: srcName || domainFromUrl(srcUrl || url),
      sourceDomain: domainFromUrl(srcUrl || url),
      date,
      url,
      tone: toneFromText(title, true),
    } as NewsItem);
  }
  return items;
}

// 미국 종목: Finnhub 실패 시 구글 뉴스 RSS(영문, 실제 기사)로 폴백한다.
async function usItemsFromGoogle(entry: CatalogEntry): Promise<NewsItem[]> {
  const query = encodeURIComponent(`${entry.name} stock`);
  const xml = await fetchText(
    `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`,
    { provider: 'google-news', headers: { 'User-Agent': 'Mozilla/5.0' } },
  );

  const items: NewsItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && items.length < 16) {
    const block = m[1];
    const title = decodeXml(pick(block, /<title>([\s\S]*?)<\/title>/));
    const url = decodeXml(pick(block, /<link>([\s\S]*?)<\/link>/));
    const pub = pick(block, /<pubDate>([\s\S]*?)<\/pubDate>/);
    const srcUrl = pick(block, /<source[^>]*url="([^"]*)"/);
    const srcName = decodeXml(pick(block, /<source[^>]*>([\s\S]*?)<\/source>/));
    if (!title || !url || !url.startsWith('http')) continue;

    const date = pub ? new Date(pub).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    items.push({
      title,
      source: srcName || domainFromUrl(srcUrl || url),
      sourceDomain: domainFromUrl(srcUrl || url),
      date,
      url,
      tone: toneFromText(title, false),
    } as NewsItem);
  }
  return items;
}

export class NewsProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewsProviderError';
  }
}

/**
 * 실제 뉴스만 반환합니다. 공급자 실패 시 가짜(샘플) 뉴스를 만들지 않고
 * NewsProviderError를 던져 라우트에서 오류로 구분해 표시합니다.
 */
async function getNews(ticker: string): Promise<NewsData | null> {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;

  try {
    let items: NewsItem[] = [];
    if (entry.market === 'KR') {
      items = await krItems(entry);
    } else {
      // 미국: Finnhub 우선, 실패(키 없음 등) 시 구글 뉴스 RSS(실제 기사)로 폴백.
      try {
        items = await usItems(entry);
      } catch (err) {
        console.error(`finnhub news failed for ${ticker}, falling back to google news:`, err);
        items = [];
      }
      if (items.length === 0) {
        items = await usItemsFromGoogle(entry);
      }
    }
    const filtered = items.filter((n) => n.url && n.url.startsWith('http'));
    return splitNews(filtered);
  } catch (err) {
    console.error(`live news failed for ${ticker}:`, err);
    throw new NewsProviderError('뉴스 공급자 호출에 실패했습니다.');
  }
}

export const NewsService = {
  getNews,
};

export { getNews };
