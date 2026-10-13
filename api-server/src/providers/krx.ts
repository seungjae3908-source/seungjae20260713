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

export const KRX_FINDER_ENDPOINT = 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';
const KRX_REQUEST_TIMEOUT_MS = 15_000;

interface FinderRow {
  short_code?: string;
  codeName?: string;
  marketName?: string;
}

// Outage/truncation guards, NOT proof of full PIT/historical listing coverage.
export function assertKrFinderSourcesReady(stocks: FinderRow[], products: FinderRow[]): void {
  const validCount = (rows: FinderRow[]) => Array.isArray(rows) ? rows.filter(row =>
    typeof row?.short_code === 'string' && /^[A-Z0-9]{6}$/.test(row.short_code.trim().toUpperCase())
    && typeof row.codeName === 'string' && row.codeName.trim().length > 0).length : 0;
  if (validCount(stocks) < 1000 || validCount(products) < 100) throw new Error('KRX_FINDER_SOURCE_PAIR_INCOMPLETE');
}

function linkedAbortSignal(parent?: AbortSignal): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason ?? new Error('KRX_UNIVERSE_ABORTED'));
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('KRX_UNIVERSE_TIMEOUT')),
    KRX_REQUEST_TIMEOUT_MS,
  );
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function krxFinder(bld: string, parent?: AbortSignal): Promise<FinderRow[]> {
  const linked = linkedAbortSignal(parent);
  try {
    const res = await fetch(KRX_FINDER_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd',
        'User-Agent': 'Mozilla/5.0',
      },
      body: `bld=${encodeURIComponent(bld)}&mktsel=ALL&searchText=`,
      signal: linked.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { block1?: FinderRow[] };
    return Array.isArray(data.block1) ? data.block1 : [];
  } catch (error) {
    if (parent?.aborted) throw error;
    return [];
  } finally {
    linked.clear();
  }
}

export async function getKrUniverse(signal?: AbortSignal): Promise<KrEntry[]> {
  // Older cache rows did not prove that both source requests succeeded.
  return cached('krx:universe:source-pair-v2', TTL.mapping, async () => {
    const [stocks, products] = await Promise.all([
      krxFinder('dbms/comm/finder/finder_stkisu', signal), // all listed stocks
      krxFinder('dbms/comm/finder/finder_secuprodisu', signal), // ETF + ETN products
    ]);
    assertKrFinderSourcesReady(stocks, products);
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
      // Legacy display heuristic only: this source does not attest a product
      // subtype. Do not treat this label as full-market/PIT classification proof.
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
