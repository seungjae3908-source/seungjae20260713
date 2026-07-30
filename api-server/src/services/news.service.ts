// NewsService — live company news.
//
// US -> Finnhub company-news (by ticker)
// KR -> Google News RSS searched by Korean company NAME (never the 6-digit
//       code), which is how Korean outlets index coverage.
//
// Items without a real http(s) URL are dropped (cards must open a real
// article). On live failure we fall back to another real provider only.
import { getCatalogEntry, type CatalogEntry } from '../data/catalog';
import { isFinnhubConfigured } from '../lib/config';
import { fetchText } from '../lib/http';
import { reportProviderFallback } from '../lib/provider-context';
import { getCompanyNews } from '../providers/finnhub';
import type { NewsData, NewsItem } from '../sample/types';

type Tone = 'positive' | 'negative';

let finnhubNotConfiguredLogged = false;

function errorDetails(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const code =
      'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error
          ? error.name
          : 'UNKNOWN_ERROR';
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown provider failure';
    return { code, message };
  }
  return { code: 'UNKNOWN_ERROR', message: String(error) };
}

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
  const pos = (kr ? POS_KO : POS_EN).filter((w) =>
    lower.includes(w.toLowerCase()),
  ).length;
  const neg = (kr ? NEG_KO : NEG_EN).filter((w) =>
    lower.includes(w.toLowerCase()),
  ).length;
  return pos >= neg ? 'positive' : 'negative';
}

function splitNews(items: NewsItem[]): NewsData {
  const positive = items.filter((n) => n.tone === 'positive');
  const negative = items.filter((n) => n.tone === 'negative');
  const pos = positive.length
    ? positive
    : items.slice(0, Math.ceil(items.length / 2));
  const neg = negative.length
    ? negative
    : items.slice(Math.ceil(items.length / 2));
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

// --- Google News RSS --------------------------------------------------------

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
  const match = block.match(re);
  return match ? match[1] : '';
}

async function krItems(entry: CatalogEntry): Promise<NewsItem[]> {
  const query = encodeURIComponent(`${entry.name} 주가`);
  const xml = await fetchText(
    `https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`,
    { provider: 'google-news', headers: { 'User-Agent': 'Mozilla/5.0' } },
  );

  const items: NewsItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null && items.length < 16) {
    const block = match[1];
    const title = decodeXml(pick(block, /<title>([\s\S]*?)<\/title>/));
    const url = decodeXml(pick(block, /<link>([\s\S]*?)<\/link>/));
    const pub = pick(block, /<pubDate>([\s\S]*?)<\/pubDate>/);
    const srcUrl = pick(block, /<source[^>]*url="([^"]*)"/);
    const srcName = decodeXml(
      pick(block, /<source[^>]*>([\s\S]*?)<\/source>/),
    );
    if (!title || !url || !url.startsWith('http')) continue;

    const date = pub
      ? new Date(pub).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
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

async function usItemsFromGoogle(entry: CatalogEntry): Promise<NewsItem[]> {
  const query = encodeURIComponent(`${entry.name} stock`);
  const xml = await fetchText(
    `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`,
    { provider: 'google-news', headers: { 'User-Agent': 'Mozilla/5.0' } },
  );

  const items: NewsItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null && items.length < 16) {
    const block = match[1];
    const title = decodeXml(pick(block, /<title>([\s\S]*?)<\/title>/));
    const url = decodeXml(pick(block, /<link>([\s\S]*?)<\/link>/));
    const pub = pick(block, /<pubDate>([\s\S]*?)<\/pubDate>/);
    const srcUrl = pick(block, /<source[^>]*url="([^"]*)"/);
    const srcName = decodeXml(
      pick(block, /<source[^>]*>([\s\S]*?)<\/source>/),
    );
    if (!title || !url || !url.startsWith('http')) continue;

    const date = pub
      ? new Date(pub).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
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
      // Finnhub 키가 없으면 예외를 종목마다 만들지 않고 Google News로 바로
      // 전환한다. 설정 누락은 프로세스당 한 번만 구조화 로그로 남긴다.
      if (isFinnhubConfigured()) {
        try {
          items = await usItems(entry);
        } catch (error) {
          reportProviderFallback('FINNHUB_NEWS_GOOGLE_FALLBACK');
          const details = errorDetails(error);
          console.log(
            JSON.stringify({
              event: 'news_provider_fallback',
              ticker,
              provider: 'finnhub',
              fallback: 'google-news',
              code: details.code,
              message: details.message,
            }),
          );
        }
      } else {
        reportProviderFallback('FINNHUB_NEWS_GOOGLE_FALLBACK');
        if (!finnhubNotConfiguredLogged) {
          finnhubNotConfiguredLogged = true;
          console.log(
            JSON.stringify({
              event: 'provider_not_configured',
              provider: 'finnhub',
              feature: 'company-news',
              fallback: 'google-news',
            }),
          );
        }
      }

      if (items.length === 0) {
        items = await usItemsFromGoogle(entry);
      }
    }

    const filtered = items.filter(
      (item) => item.url && item.url.startsWith('http'),
    );
    return splitNews(filtered);
  } catch (error) {
    const details = errorDetails(error);
    console.error(
      JSON.stringify({
        event: 'news_provider_failed',
        ticker,
        code: details.code,
        message: details.message,
      }),
    );
    throw new NewsProviderError('뉴스 공급자 호출에 실패했습니다.');
  }
}

export const NewsService = {
  getNews,
};

export { getNews };
