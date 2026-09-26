// Asset-type classification shared across search, ETF/ETN handling, scanner and
// AI warnings. Derived from the instrument NAME (+ an optional raw type hint
// from the provider), since neither KRX finder nor Finnhub search returns a
// clean normalized asset class.
import type { Market } from './catalog';

export type AssetType =
  | 'STOCK'
  | 'ETF'
  | 'ETN'
  | 'LEVERAGED_ETF'
  | 'INVERSE_ETF'
  | 'LEVERAGED_ETN'
  | 'INVERSE_ETN'
  | 'REIT'
  | 'ADR';

// Korean ETF/ETN issuer brand prefixes (many KR ETF names omit the word "ETF").
const KR_FUND_BRANDS = [
  'KODEX',
  'TIGER',
  'ACE',
  'SOL',
  'KBSTAR',
  'HANARO',
  'RISE',
  'TIMEFOLIO',
  'ARIRANG',
  'PLUS',
  'KOSEF',
  'KIWOOM',
  'WON',
  'FOCUS',
  'TREX',
  'BNK',
  'HK',
  '마이티',
  '히어로즈',
];

function hasLeverage(name: string): boolean {
  return /(레버리지|2배|3배|2X|3X|bull|ultra|leveraged)/i.test(name);
}

function hasInverse(name: string): boolean {
  return /(인버스|곱버스|inverse|bear|short|-1x|-2x|reverse)/i.test(name);
}

export function classifyAssetType(
  name: string,
  _market: Market,
  rawType?: string,
): AssetType {
  const n = name ?? '';
  const upper = n.toUpperCase();
  const t = (rawType ?? '').toLowerCase();

  const lev = hasLeverage(n);
  const inv = hasInverse(n);
  // Korean REIT names end with 리츠 (e.g. 롯데리츠); require the suffix so that
  // 메리츠금융지주 / 메리츠화재 (리츠 mid-word) aren't misclassified.
  const isReit = /리츠$/.test(n) || /reit/i.test(n) || t.includes('reit');
  const isEtn = /상장지수증권|\betn\b/i.test(n) || t.includes('etn');
  const brandFund = KR_FUND_BRANDS.some((b) => upper.includes(b));
  const isEtf =
    t === 'etp' ||
    t.includes('etf') ||
    /상장지수펀드|\betf\b/i.test(n) ||
    brandFund ||
    // Leverage/inverse naming (Bull/Bear/3X/UltraPro/...) is a reliable ETP
    // signal even when the provider type is missing (e.g. Finnhub tags SOXL as
    // a common stock).
    ((lev || inv) && !isEtn);

  if (isReit) return 'REIT';
  if (isEtn) {
    if (inv) return 'INVERSE_ETN';
    if (lev) return 'LEVERAGED_ETN';
    return 'ETN';
  }
  if (isEtf) {
    if (inv) return 'INVERSE_ETF';
    if (lev) return 'LEVERAGED_ETF';
    return 'ETF';
  }
  if (t === 'adr' || /\badr\b/i.test(n)) return 'ADR';
  return 'STOCK';
}

const ETP_TYPES: ReadonlySet<AssetType> = new Set<AssetType>([
  'ETF',
  'ETN',
  'LEVERAGED_ETF',
  'INVERSE_ETF',
  'LEVERAGED_ETN',
  'INVERSE_ETN',
]);

// ETF/ETN family — no individual company financial statements.
export function isEtp(a: AssetType): boolean {
  return ETP_TYPES.has(a);
}

export function isLeveraged(a: AssetType): boolean {
  return a === 'LEVERAGED_ETF' || a === 'LEVERAGED_ETN';
}

export function isInverse(a: AssetType): boolean {
  return a === 'INVERSE_ETF' || a === 'INVERSE_ETN';
}

export function isEtn(a: AssetType): boolean {
  return a === 'ETN' || a === 'LEVERAGED_ETN' || a === 'INVERSE_ETN';
}

const LABELS: Record<AssetType, string> = {
  STOCK: '주식',
  ETF: 'ETF',
  ETN: 'ETN',
  LEVERAGED_ETF: '레버리지 ETF',
  INVERSE_ETF: '인버스 ETF',
  LEVERAGED_ETN: '레버리지 ETN',
  INVERSE_ETN: '인버스 ETN',
  REIT: '리츠',
  ADR: 'ADR',
};

export function assetTypeLabel(a: AssetType): string {
  return LABELS[a] ?? a;
}
