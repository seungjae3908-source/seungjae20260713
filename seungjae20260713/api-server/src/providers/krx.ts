// KRX provider: the full Korean listing universe (stocks + ETF + ETN) via the
// public KRX data portal "finder" endpoints. Used to power search across the
// entire KOSPI/KOSDAQ/KONEX market instead of only the curated catalog.
// The lists are fetched once and cached (24h); on any failure search degrades
// to the curated catalog, so this is a best-effort enrichment.
import { cached, TTL } from '../lib/cache';
import { classifyAssetType, type AssetType } from '../data/asset-type';

export interface KrEntry {
  ticker: string; // KRX short code (6 chars; ETF/ETN may be alphanumeric)
  name: string;
  marketName: string; // 코스피 / 코스닥 / 코넥스 / ETF·ETN
  assetType: AssetType;
}

const KRX_URL = 'http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';

interface FinderRow {
  short_code?: string;
  codeName?: string;
  marketName?: string;
}

async function krxFinder(bld: string): Promise<FinderRow[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(KRX_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd',
        'User-Agent': 'Mozilla/5.0',
      },
      body: `bld=${encodeURIComponent(bld)}&mktsel=ALL&searchText=`,
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { block1?: FinderRow[] };
    return Array.isArray(data.block1) ? data.block1 : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function getKrUniverse(): Promise<KrEntry[]> {
  return cached('krx:universe', TTL.mapping, async () => {
    const [stocks, products] = await Promise.all([
      krxFinder('dbms/comm/finder/finder_stkisu'), // all listed stocks
      krxFinder('dbms/comm/finder/finder_secuprodisu'), // ETF + ETN products
    ]);
    const out: KrEntry[] = [];
    for (const s of stocks) {
      if (!s.short_code || !s.codeName) continue;
      out.push({
        ticker: s.short_code,
        name: s.codeName,
        marketName: s.marketName ?? '',
        assetType: classifyAssetType(s.codeName, 'KR'),
      });
    }
    for (const p of products) {
      if (!p.short_code || !p.codeName) continue;
      // Everything in the securities-product finder is an ETF/ETN; if the name
      // doesn't self-identify, default to ETF rather than mislabeling as STOCK.
      let at = classifyAssetType(p.codeName, 'KR');
      if (at === 'STOCK' || at === 'ADR' || at === 'REIT') at = 'ETF';
      out.push({
        ticker: p.short_code,
        name: p.codeName,
        marketName: 'ETF·ETN',
        assetType: at,
      });
    }
    return out;
  });
}
