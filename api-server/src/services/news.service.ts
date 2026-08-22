// NewsService — live company news with explicit evidence provenance.
//
// US -> Finnhub company-news (ticker-scoped provider), then Google News fallback.
// KR -> Google News RSS searched by Korean company NAME (never the 6-digit code).
//
// Missing original URLs or timestamps remain explicit missing evidence. They do
// not cause an otherwise identified article to disappear, and they are never
// backfilled with the current time. Provider failures remain explicit; no
// sample/fabricated news is used.
import { getCatalogEntry, type CatalogEntry } from '../data/catalog';
import { getCompanyNews } from '../providers/finnhub';
import { fetchText } from '../lib/http';
import type { NewsData, NewsItem } from '../sample/types';
import { summarizeNewsSentiment, toneFromNewsText } from './news-sentiment';

type NewsProvider = 'FINNHUB' | 'GOOGLE_NEWS';
type NewsEvidenceProvenance = 'PROVIDER_SUPPLIED' | 'NOT_PROVIDED';
type NewsRelevanceProvenance = 'TICKER_SCOPED_PROVIDER' | 'COMPANY_NAME_QUERY';

type EvidenceNewsItem = NewsItem & {
  provider: NewsProvider;
  publishedAt?: string;
  collectedAt: string;
  relevanceProvenance: NewsRelevanceProvenance;
  confidenceProvenance: NewsEvidenceProvenance;
  summaryProvenance: NewsEvidenceProvenance;
  impactProvenance: NewsEvidenceProvenance;
};

function isoFromUnix(value?: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isoFromDateText(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeHttpUrl(value?: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function domainFromUrl(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizedTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function canonicalUrl(value: string): string | null {
  const safe = safeHttpUrl(value);
  if (!safe) return null;
  const parsed = new URL(safe);
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Removes only deterministic duplicates. This is not semantic same-event
 * clustering and does not claim that similarly worded stories describe the
 * same market event.
 */
export function dedupeNewsItems<T extends NewsItem>(items: T[]): T[] {
  const seenUrls = new Set<string>();
  const seenTitleSources = new Set<string>();

  return items.filter((item) => {
    const urlKey = canonicalUrl(item.url);
    const titleKey = normalizedTitle(item.title);
    const sourceKey = String(item.sourceDomain || item.source || '').trim().toLowerCase();
    const titleSourceKey = titleKey && sourceKey ? `${sourceKey}|${titleKey}` : null;

    if (urlKey && seenUrls.has(urlKey)) return false;
    if (titleSourceKey && seenTitleSources.has(titleSourceKey)) return false;

    if (urlKey) seenUrls.add(urlKey);
    if (titleSourceKey) seenTitleSources.add(titleSourceKey);
    return true;
  });
}

async function usItems(entry: CatalogEntry, collectedAt: string): Promise<EvidenceNewsItem[]> {
  const raw = await getCompanyNews(entry);
  return raw
    .filter((n) => typeof n.headline === 'string' && n.headline.trim())
    .slice(0, 14)
    .map((n) => {
      const url = safeHttpUrl(n.url);
      const publishedAt = isoFromUnix(n.datetime);
      const summary = typeof n.summary === 'string' && n.summary.trim() ? n.summary.trim() : undefined;
      return {
        title: n.headline.trim(),
        source: n.source || domainFromUrl(url) || '미제공',
        sourceDomain: domainFromUrl(url),
        date: publishedAt?.slice(0, 10) ?? '',
        url,
        tone: toneFromNewsText(`${n.headline} ${summary ?? ''}`, false),
        summary,
        provider: 'FINNHUB',
        publishedAt: publishedAt ?? undefined,
        collectedAt,
        relevanceProvenance: 'TICKER_SCOPED_PROVIDER',
        confidenceProvenance: 'NOT_PROVIDED',
        summaryProvenance: summary ? 'PROVIDER_SUPPLIED' : 'NOT_PROVIDED',
        impactProvenance: 'NOT_PROVIDED',
      } as EvidenceNewsItem;
    });
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

function googleItem(
  block: string,
  collectedAt: string,
  kr: boolean,
): EvidenceNewsItem | null {
  const title = decodeXml(pick(block, /<title>([\s\S]*?)<\/title>/));
  if (!title) return null;

  const rawUrl = decodeXml(pick(block, /<link>([\s\S]*?)<\/link>/));
  const url = safeHttpUrl(rawUrl);
  const pub = pick(block, /<pubDate>([\s\S]*?)<\/pubDate>/);
  const publishedAt = isoFromDateText(pub);
  const srcUrl = safeHttpUrl(pick(block, /<source[^>]*url="([^"]*)"/));
  const srcName = decodeXml(pick(block, /<source[^>]*>([\s\S]*?)<\/source>/));

  return {
    title,
    source: srcName || domainFromUrl(srcUrl || url) || '미제공',
    sourceDomain: domainFromUrl(srcUrl || url),
    date: publishedAt?.slice(0, 10) ?? '',
    url,
    tone: toneFromNewsText(title, kr),
    provider: 'GOOGLE_NEWS',
    publishedAt: publishedAt ?? undefined,
    collectedAt,
    relevanceProvenance: 'COMPANY_NAME_QUERY',
    confidenceProvenance: 'NOT_PROVIDED',
    summaryProvenance: 'NOT_PROVIDED',
    impactProvenance: 'NOT_PROVIDED',
  };
}

async function googleItems(
  entry: CatalogEntry,
  collectedAt: string,
  kr: boolean,
): Promise<EvidenceNewsItem[]> {
  const query = encodeURIComponent(`${entry.name} ${kr ? '주가' : 'stock'}`);
  const locale = kr ? 'hl=ko&gl=KR&ceid=KR:ko' : 'hl=en-US&gl=US&ceid=US:en';
  const xml = await fetchText(
    `https://news.google.com/rss/search?q=${query}&${locale}`,
    { provider: 'google-news', headers: { 'User-Agent': 'Mozilla/5.0' } },
  );

  const items: EvidenceNewsItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && items.length < 16) {
    const item = googleItem(m[1], collectedAt, kr);
    if (item) items.push(item);
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

  const collectedAt = new Date().toISOString();
  try {
    let items: EvidenceNewsItem[] = [];
    if (entry.market === 'KR') {
      items = await googleItems(entry, collectedAt, true);
    } else {
      try {
        items = await usItems(entry, collectedAt);
      } catch (err) {
        console.error(`finnhub news failed for ${ticker}, falling back to google news:`, err);
        items = [];
      }
      if (items.length === 0) {
        items = await googleItems(entry, collectedAt, false);
      }
    }

    return summarizeNewsSentiment(dedupeNewsItems(items));
  } catch (err) {
    console.error(`live news failed for ${ticker}:`, err);
    throw new NewsProviderError('뉴스 공급자 호출에 실패했습니다.');
  }
}

export const NewsService = {
  getNews,
};

export { getNews };
