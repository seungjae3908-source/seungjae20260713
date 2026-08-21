// NewsService — live company news.
//
// US -> Finnhub company-news (by ticker)
// KR -> Google News RSS searched by Korean company NAME (never the 6-digit
//       code), which is how Korean outlets index coverage.
//
// Items without a real http(s) URL are dropped (cards must open a real
// article). Provider failures remain explicit; no sample/fabricated news is used.
import { getCatalogEntry, type CatalogEntry } from '../data/catalog';
import { getCompanyNews } from '../providers/finnhub';
import { fetchText } from '../lib/http';
import type { NewsData, NewsItem } from '../sample/types';
import { summarizeNewsSentiment, toneFromNewsText } from './news-sentiment';

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

async function usItems(entry: CatalogEntry): Promise<NewsItem[]> {
  const raw = await getCompanyNews(entry);
  return raw
    .filter((n) => n.headline && n.url && n.url.startsWith('http'))
    .slice(0, 14)
    .map((n) => ({
      title: n.headline,
      source: n.source || domainFromUrl(n.url),
      sourceDomain: domainFromUrl(n.url),
      date: dateFromUnix(n.datetime),
      url: n.url,
      tone: toneFromNewsText(`${n.headline} ${n.summary}`, false),
      summary: typeof n.summary === 'string' && n.summary.trim() ? n.summary.trim() : undefined,
    } as NewsItem));
}

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
      tone: toneFromNewsText(title, true),
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
      tone: toneFromNewsText(title, false),
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

async function getNews(ticker: string): Promise<NewsData | null> {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;

  try {
    let items: NewsItem[] = [];
    if (entry.market === 'KR') {
      items = await krItems(entry);
    } else {
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
    return summarizeNewsSentiment(filtered);
  } catch (err) {
    console.error(`live news failed for ${ticker}:`, err);
    throw new NewsProviderError('뉴스 공급자 호출에 실패했습니다.');
  }
}

export const NewsService = {
  getNews,
};

export { getNews };
