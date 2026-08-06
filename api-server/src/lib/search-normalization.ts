export type UnifiedAssetType = 'stock' | 'coin';
export type UnifiedSearchMarket = 'KR' | 'US' | 'spot' | 'futures';
export type UnifiedInstrumentType = 'stock' | 'spot' | 'futures';

export type UnifiedSearchMatchType =
  | 'code_exact'
  | 'name_exact'
  | 'code_prefix'
  | 'name_prefix'
  | 'word_prefix'
  | 'alias'
  | 'contains'
  | 'choseong'
  | 'fuzzy';

export interface UnifiedAssetDocument {
  id: string;
  assetType: UnifiedAssetType;
  market: UnifiedSearchMarket;
  instrumentType: UnifiedInstrumentType;
  exchange: string;
  ticker?: string;
  symbol?: string;
  productCode: string;
  koreanName: string;
  englishName: string;
  displayName: string;
  aliases: string[];
  baseSymbol: string;
  quoteCurrency: string;
  active: boolean;
  provider: string;
  dataAsOf: string;
  liquidityRank?: number | null;
}

export interface NormalizedSearchText {
  original: string;
  nfkc: string;
  lower: string;
  compact: string;
  separatorless: string;
  choseong: string;
  words: string[];
}

export interface ScoredSearchDocument {
  document: UnifiedAssetDocument;
  score: number;
  matchType: UnifiedSearchMatchType;
  matchedValue: string;
}

const CHOSEONG = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ',
  'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

const CHOSEONG_JAMO = [
  'ᄀ', 'ᄁ', 'ᄂ', 'ᄃ', 'ᄄ', 'ᄅ', 'ᄆ', 'ᄇ', 'ᄈ', 'ᄉ', 'ᄊ',
  'ᄋ', 'ᄌ', 'ᄍ', 'ᄎ', 'ᄏ', 'ᄐ', 'ᄑ', 'ᄒ',
] as const;

const SEARCH_SEPARATORS = /[\s\-./_:·・]+/gu;
const COMPACT_PUNCTUATION = /[\s\-./_:·・()[\]{}'"`]+/gu;

export function extractHangulChoseong(value: string): string {
  let output = '';
  for (const character of value.normalize('NFKC')) {
    const code = character.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      output += CHOSEONG[Math.floor((code - 0xac00) / 588)] ?? '';
      continue;
    }
    const jamoIndex = CHOSEONG_JAMO.indexOf(character as (typeof CHOSEONG_JAMO)[number]);
    if (jamoIndex >= 0) {
      output += CHOSEONG[jamoIndex];
      continue;
    }
    if (/[ㄱ-ㅎ0-9a-z]/iu.test(character)) output += character.toLowerCase();
  }
  return output;
}

export function normalizeSearchText(value: unknown): NormalizedSearchText {
  const original = String(value ?? '');
  const nfkc = original.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const lower = nfkc.toLocaleLowerCase('ko-KR');
  const compact = lower.replace(COMPACT_PUNCTUATION, '');
  const separatorless = lower.replace(SEARCH_SEPARATORS, '');
  const words = lower.split(SEARCH_SEPARATORS).filter(Boolean);
  return {
    original,
    nfkc,
    lower,
    compact,
    separatorless,
    choseong: extractHangulChoseong(lower),
    words,
  };
}

export function canonicalProductCode(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toUpperCase();
}

export function createUnifiedAssetId(input: Pick<UnifiedAssetDocument, 'assetType' | 'market' | 'exchange' | 'productCode'>): string {
  return [
    input.assetType,
    input.market,
    canonicalProductCode(input.exchange),
    canonicalProductCode(input.productCode),
  ].join(':');
}

function valuesForDocument(document: UnifiedAssetDocument) {
  const codeValues = Array.from(new Set([
    document.ticker,
    document.symbol,
    document.productCode,
    document.baseSymbol,
  ].filter((value): value is string => Boolean(value))));
  const nameValues = Array.from(new Set([
    document.koreanName,
    document.englishName,
    document.displayName,
  ].filter(Boolean)));
  const aliasValues = Array.from(new Set(document.aliases.filter(Boolean)));
  return {
    codes: codeValues.map((value) => ({ value, normalized: normalizeSearchText(value) })),
    names: nameValues.map((value) => ({ value, normalized: normalizeSearchText(value) })),
    aliases: aliasValues.map((value) => ({ value, normalized: normalizeSearchText(value) })),
  };
}

function equalWhenPresent(left: string, right: string): boolean {
  return Boolean(left && right && left === right);
}

function startsWithWhenPresent(query: string, candidate: string): boolean {
  return Boolean(query && candidate && candidate.startsWith(query));
}

function includesWhenPresent(query: string, candidate: string): boolean {
  return Boolean(query && candidate && candidate.includes(query));
}

function equivalent(a: NormalizedSearchText, b: NormalizedSearchText): boolean {
  return (
    equalWhenPresent(a.lower, b.lower) ||
    equalWhenPresent(a.compact, b.compact) ||
    equalWhenPresent(a.separatorless, b.separatorless)
  );
}

function startsWith(a: NormalizedSearchText, b: NormalizedSearchText): boolean {
  return (
    startsWithWhenPresent(a.lower, b.lower) ||
    startsWithWhenPresent(a.compact, b.compact) ||
    startsWithWhenPresent(a.separatorless, b.separatorless)
  );
}

function includes(a: NormalizedSearchText, b: NormalizedSearchText): boolean {
  return (
    includesWhenPresent(a.lower, b.lower) ||
    includesWhenPresent(a.compact, b.compact) ||
    includesWhenPresent(a.separatorless, b.separatorless)
  );
}

function isWordPrefix(query: NormalizedSearchText, candidate: NormalizedSearchText): boolean {
  if (!query.lower) return false;
  return candidate.words.some((word) => word.startsWith(query.lower));
}

export function boundedLevenshtein(left: string, right: string, maximum = 2): number | null {
  if (Math.abs(left.length - right.length) > maximum) return null;
  if (left === right) return 0;
  if (!left || !right) return Math.max(left.length, right.length) <= maximum ? Math.max(left.length, right.length) : null;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      const insertion = current[rightIndex - 1] + 1;
      const deletion = previous[rightIndex] + 1;
      const value = Math.min(substitution, insertion, deletion);
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return null;
    previous = current;
  }
  const distance = previous[right.length];
  return distance <= maximum ? distance : null;
}

export function scoreUnifiedAssetDocument(
  document: UnifiedAssetDocument,
  rawQuery: string,
  preferredMarket?: UnifiedSearchMarket | null,
): ScoredSearchDocument | null {
  const query = normalizeSearchText(rawQuery);
  if (!query.lower) return null;
  const values = valuesForDocument(document);

  let result: Omit<ScoredSearchDocument, 'document'> | null = null;
  const choose = (score: number, matchType: UnifiedSearchMatchType, matchedValue: string) => {
    if (!result || score > result.score) result = { score, matchType, matchedValue };
  };

  for (const item of values.codes) {
    if (equivalent(query, item.normalized)) choose(10_000, 'code_exact', item.value);
    else if (startsWith(query, item.normalized)) choose(8_000, 'code_prefix', item.value);
  }
  for (const item of values.names) {
    if (equivalent(query, item.normalized)) choose(9_000, 'name_exact', item.value);
    else if (startsWith(query, item.normalized)) choose(7_000, 'name_prefix', item.value);
    else if (isWordPrefix(query, item.normalized)) choose(6_500, 'word_prefix', item.value);
  }
  for (const item of values.aliases) {
    if (equivalent(query, item.normalized)) choose(6_200, 'alias', item.value);
    else if (startsWith(query, item.normalized)) choose(6_000, 'alias', item.value);
  }
  for (const item of [...values.names, ...values.aliases, ...values.codes]) {
    if (includes(query, item.normalized)) choose(5_000, 'contains', item.value);
  }
  if (query.choseong && /^[ㄱ-ㅎ]+$/u.test(query.choseong)) {
    for (const item of [...values.names, ...values.aliases]) {
      if (item.normalized.choseong.startsWith(query.choseong)) {
        choose(4_000, 'choseong', item.value);
      }
    }
  }

  if (!result && query.compact.length >= 3) {
    for (const item of [...values.names, ...values.aliases]) {
      const candidate = item.normalized.compact;
      if (!candidate || Math.abs(candidate.length - query.compact.length) > 1) continue;
      const distance = boundedLevenshtein(query.compact, candidate, 1);
      if (distance != null) choose(2_000 - distance * 100, 'fuzzy', item.value);
    }
  }

  const finalResult = result as Omit<ScoredSearchDocument, 'document'> | null;
  if (!finalResult) return null;
  let score = finalResult.score;
  if (document.active) score += 300;
  if (preferredMarket && document.market === preferredMarket) score += 200;
  if (Number.isFinite(document.liquidityRank) && Number(document.liquidityRank) > 0) {
    score += Math.max(0, 100 - Math.min(100, Number(document.liquidityRank)));
  }
  return { document, score, matchType: finalResult.matchType, matchedValue: finalResult.matchedValue };
}

export function searchUnifiedAssetDocuments(
  documents: UnifiedAssetDocument[],
  query: string,
  options: {
    asset?: 'all' | UnifiedAssetType;
    market?: UnifiedSearchMarket | null;
    limit?: number;
  } = {},
): ScoredSearchDocument[] {
  const normalized = normalizeSearchText(query);
  if (!normalized.lower) return [];
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 25)));
  return documents
    .filter((document) => options.asset == null || options.asset === 'all' || document.assetType === options.asset)
    .filter((document) => !options.market || document.market === options.market)
    .map((document) => scoreUnifiedAssetDocument(document, normalized.nfkc, options.market))
    .filter((item): item is ScoredSearchDocument => Boolean(item))
    .sort((left, right) =>
      right.score - left.score ||
      Number(right.document.active) - Number(left.document.active) ||
      left.document.displayName.localeCompare(right.document.displayName, 'ko-KR') ||
      left.document.id.localeCompare(right.document.id),
    )
    .slice(0, limit);
}
