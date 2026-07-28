import AdmZip from 'adm-zip';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';
import {
	THEME_TAXONOMY,
	type ThemeDefinition,
	type ThemeRelationLevel,
} from '../data/theme-taxonomy';
import type { Currency, Market } from '../data/catalog';
import type { CompanyProfile } from '../sample/types';

export type ReviewStatus = 'candidate' | 'approved' | 'rejected';

export interface CompanyEntryInput {
	ticker: string;
	name: string;
	market: Market | string;
	currency: Currency | string;
	assetType?: string;
	exchange?: string;
}

export interface EvidenceCompanyProfile extends CompanyProfile {
	website?: string;
	exchange?: string;
	officialIndustry?: string;
	businessSummary?: string;
	mainProducts?: string[];
	evidenceExcerpt?: string;
	sourceType?: 'DART' | 'SEC' | 'NONE';
	sourceUrl?: string;
	sourceDocumentId?: string;
	sourceDate?: string;
	confidence?: number;
	dataQuality?: 'official' | 'partial' | 'insufficient';
	reviewStatus?: ReviewStatus;
	adminVerified?: boolean;
	updatedAt?: string;
}

export interface ThemeRelationRecord {
	market: 'KR' | 'US';
	ticker: string;
	name: string;
	currency: 'KRW' | 'USD';
	themeKey: string;
	themeLabel: string;
	relationLevel: ThemeRelationLevel;
	reason: string;
	evidence: string;
	confidence: number;
	sourceType: 'DART' | 'SEC';
	sourceUrl: string;
	sourceDocumentId: string;
	sourceDate: string;
	reviewStatus: ReviewStatus;
	adminVerified: boolean;
	updatedAt: string;
}

export interface CompanyIntelligenceStatus {
	market: 'KR' | 'US';
	universeCount: number;
	classifiedCount: number;
	profileCount: number;
	relationCount: number;
	cursor: number;
	running: boolean;
	lastRunAt: string | null;
	lastError: string | null;
	storage: 'supabase' | 'local';
}

interface CacheProgress {
	universeCount: number;
	cursor: number;
	running: boolean;
	lastRunAt: string | null;
	lastError: string | null;
}

interface CacheDocument {
	version: 2;
	profiles: Record<string, EvidenceCompanyProfile>;
	relations: Record<string, ThemeRelationRecord>;
	progress: Record<'KR' | 'US', CacheProgress>;
}

interface DartCorpCodeRow {
	corpCode: string;
	corpName: string;
	stockCode: string;
	modifyDate: string;
}

interface SecTickerRow {
	cik: number;
	ticker: string;
	title: string;
	exchange?: string;
}

interface FilingEvidence {
	industry: string;
	country: string;
	website: string;
	exchange: string;
	sourceType: 'DART' | 'SEC';
	sourceUrl: string;
	sourceDocumentId: string;
	sourceDate: string;
	rawBusinessText: string;
	evidenceExcerpt: string;
	companyName: string;
}

const CACHE_VERSION = 2 as const;
const PROFILE_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 18_000;
const MAX_EVIDENCE_TEXT = 80_000;
const MAX_SUMMARY_LENGTH = 750;
const LOCAL_CACHE_FILE = process.env.COMPANY_INTELLIGENCE_CACHE_FILE?.trim() ||
	path.resolve(process.cwd(), 'data/company-intelligence-cache.json');

const jobs: Record<'KR' | 'US', Promise<void> | null> = { KR: null, US: null };
let memoryCache: CacheDocument | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let dartCorpCodesCache: { at: number; rows: Map<string, DartCorpCodeRow> } | null = null;
let secTickersCache: { at: number; rows: Map<string, SecTickerRow> } | null = null;

function cleanTicker(value: unknown): string {
	return String(value ?? '').trim().toUpperCase();
}

function normalizeMarket(value: unknown, ticker = ''): 'KR' | 'US' {
	if (String(value ?? '').toUpperCase() === 'US') return 'US';
	if (String(value ?? '').toUpperCase() === 'KR') return 'KR';
	return /^\d{6}$/.test(cleanTicker(ticker)) ? 'KR' : 'US';
}

function normalizeCurrency(value: unknown, market: 'KR' | 'US'): 'KRW' | 'USD' {
	return String(value ?? '').toUpperCase() === 'USD' || market === 'US' ? 'USD' : 'KRW';
}

function profileKey(market: 'KR' | 'US', ticker: string): string {
	return `${market}:${cleanTicker(ticker)}`;
}

function relationKey(record: Pick<ThemeRelationRecord, 'market' | 'ticker' | 'themeKey'>): string {
	return `${record.market}:${cleanTicker(record.ticker)}:${record.themeKey}`;
}

function emptyProgress(): CacheProgress {
	return {
		universeCount: 0,
		cursor: 0,
		running: false,
		lastRunAt: null,
		lastError: null,
	};
}

function emptyCache(): CacheDocument {
	return {
		version: CACHE_VERSION,
		profiles: {},
		relations: {},
		progress: { KR: emptyProgress(), US: emptyProgress() },
	};
}

async function loadLocalCache(): Promise<CacheDocument> {
	if (memoryCache) return memoryCache;

	try {
		const raw = await readFile(LOCAL_CACHE_FILE, 'utf8');
		const parsed = JSON.parse(raw) as Partial<CacheDocument>;
		memoryCache = {
			version: CACHE_VERSION,
			profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
			relations: parsed.relations && typeof parsed.relations === 'object' ? parsed.relations : {},
			progress: {
				KR: { ...emptyProgress(), ...(parsed.progress?.KR ?? {}) },
				US: { ...emptyProgress(), ...(parsed.progress?.US ?? {}) },
			},
		};
	} catch {
		memoryCache = emptyCache();
	}

	return memoryCache;
}

async function persistLocalCache(): Promise<void> {
	const cache = await loadLocalCache();
	writeQueue = writeQueue.then(async () => {
		const directory = path.dirname(LOCAL_CACHE_FILE);
		await mkdir(directory, { recursive: true });
		const temp = `${LOCAL_CACHE_FILE}.tmp`;
		await writeFile(temp, JSON.stringify(cache, null, 2), 'utf8');
		await rename(temp, LOCAL_CACHE_FILE);
	});
	await writeQueue;
}

function safeDate(value: unknown): string {
	const text = String(value ?? '').trim();
	if (/^\d{8}$/.test(text)) {
		return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
	}
	if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
	return '';
}

function isFresh(profile: EvidenceCompanyProfile): boolean {
	const updated = Date.parse(String(profile.updatedAt ?? ''));
	if (!Number.isFinite(updated)) return false;
	const maxAge = profile.dataQuality === 'insufficient' || profile.sourceType === 'NONE'
		? 10 * 60 * 1000
		: PROFILE_STALE_MS;
	return Date.now() - updated < maxAge;
}

function decodeEntities(value: string): string {
	const named: Record<string, string> = {
		amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
	};
	return value
		.replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&([a-z]+);/gi, (m, n) => named[String(n).toLowerCase()] ?? m);
}

function stripMarkup(value: string): string {
	return decodeEntities(
		value
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>|<\/div>|<\/tr>|<\/li>|<\/section>/gi, '\n')
			.replace(/<[^>]+>/g, ' '),
	)
		.replace(/[\t\r]+/g, ' ')
		.replace(/ +/g, ' ')
		.replace(/\n\s*\n+/g, '\n')
		.trim();
}

function decodeBuffer(buffer: Buffer): string {
	const utf8 = buffer.toString('utf8');
	const replacementCount = (utf8.match(/�/g) ?? []).length;
	if (replacementCount <= 3) return utf8;

	try {
		return new TextDecoder('euc-kr').decode(buffer);
	} catch {
		return utf8;
	}
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
	const response = await fetchWithTimeout(url, init);
	const text = await response.text();
	if (!response.ok) throw new Error(`HTTP_${response.status}:${text.slice(0, 180)}`);
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`INVALID_JSON:${text.slice(0, 180)}`);
	}
}

function xmlTag(block: string, tag: string): string {
	const match = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
	return decodeEntities(String(match?.[1] ?? '')).trim();
}

function meaningfulSentences(text: string, limit = MAX_SUMMARY_LENGTH): string {
	const cleaned = text
		.replace(/\s+/g, ' ')
		.replace(/^[\d\s.ⅠⅡⅢⅣⅤIVX]+/, '')
		.trim();
	if (!cleaned) return '';

	const sentences = cleaned
		.split(/(?<=[.!?。]|다\.)\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length >= 30 && sentence.length <= 450)
		.filter((sentence) => !/^(목차|table of contents|item\s+\d+)/i.test(sentence));

	let result = '';
	for (const sentence of sentences) {
		if (result.length + sentence.length + 1 > limit) break;
		result += `${result ? ' ' : ''}${sentence}`;
		if (result.length >= Math.min(420, limit)) break;
	}

	if (result) return result;
	return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

function normalizeSearchText(value: string): string {
	return value
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[‐‑‒–—―]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
}

function termRegex(term: string): RegExp {
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
	const asciiShort = /^[a-z0-9-]{1,4}$/i.test(term);
	return new RegExp(asciiShort ? `(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])` : escaped, 'i');
}

function matchedTerms(text: string, terms: string[]): string[] {
	return terms.filter((term) => termRegex(normalizeSearchText(term)).test(text));
}

function excerptAround(text: string, terms: string[], max = 260): string {
	const normalized = normalizeSearchText(text);
	let index = -1;
	for (const term of terms) {
		index = normalized.search(termRegex(normalizeSearchText(term)));
		if (index >= 0) break;
	}
	if (index < 0) return meaningfulSentences(text, max);

	const start = Math.max(0, index - Math.floor(max * 0.35));
	const end = Math.min(text.length, start + max);
	const chunk = text.slice(start, end).replace(/\s+/g, ' ').trim();
	return `${start > 0 ? '…' : ''}${chunk}${end < text.length ? '…' : ''}`;
}

function classifyThemes(
	entry: CompanyEntryInput,
	evidence: FilingEvidence,
): ThemeRelationRecord[] {
	const text = normalizeSearchText(`${evidence.industry}\n${evidence.rawBusinessText}`);
	const industry = normalizeSearchText(evidence.industry);
	const now = new Date().toISOString();
	const relations: ThemeRelationRecord[] = [];

	for (const definition of THEME_TAXONOMY) {
		const strong = matchedTerms(text, definition.strongTerms);
		const normal = matchedTerms(text, definition.terms);
		const industryMatches = matchedTerms(industry, definition.industryTerms ?? []);
		const unique = Array.from(new Set([...strong, ...normal, ...industryMatches]));

		// 종목명 또는 너무 일반적인 단어 하나만으로는 분류하지 않습니다.
		if (strong.length === 0 && industryMatches.length === 0 && normal.length < 2) continue;

		let confidence = 34;
		confidence += Math.min(36, strong.length * 18);
		confidence += Math.min(24, normal.length * 8);
		confidence += Math.min(12, industryMatches.length * 12);
		if (strong.length >= 2 || unique.length >= 4) confidence += 6;
		confidence = Math.max(40, Math.min(96, confidence));

		const relationLevel: ThemeRelationLevel =
			industryMatches.length > 0 || strong.length >= 2
				? '핵심사업'
				: unique.length >= 3
					? '관련사업'
					: '연관';

		const matched = unique.slice(0, 5);
		relations.push({
			market: normalizeMarket(entry.market, entry.ticker),
			ticker: cleanTicker(entry.ticker),
			name: String(entry.name || evidence.companyName || entry.ticker),
			currency: normalizeCurrency(entry.currency, normalizeMarket(entry.market, entry.ticker)),
			themeKey: definition.key,
			themeLabel: definition.label,
			relationLevel,
			reason: `최근 공식 공시의 사업 내용에서 ${definition.label} 관련 근거(${matched.join(', ')})가 확인되었습니다.`,
			evidence: excerptAround(evidence.rawBusinessText, matched, 300),
			confidence,
			sourceType: evidence.sourceType,
			sourceUrl: evidence.sourceUrl,
			sourceDocumentId: evidence.sourceDocumentId,
			sourceDate: evidence.sourceDate,
			reviewStatus: 'candidate',
			adminVerified: false,
			updatedAt: now,
		});
	}

	return relations.sort((a, b) => b.confidence - a.confidence);
}

function productsFromRelations(relations: ThemeRelationRecord[]): string[] {
	return relations.slice(0, 6).map((relation) => relation.themeLabel);
}

function makeKoreanSummary(
	entry: CompanyEntryInput,
	evidence: FilingEvidence,
	relations: ThemeRelationRecord[],
): string {
	if (evidence.sourceType === 'DART') {
		const extracted = meaningfulSentences(evidence.rawBusinessText, MAX_SUMMARY_LENGTH);
		if (extracted) return extracted;
	}

	const themes = productsFromRelations(relations);
	const industry = evidence.industry || '공식 업종 미확인';
	if (themes.length > 0) {
		return `${entry.name}은(는) ${industry} 분야의 기업입니다. 최근 공식 공시의 사업 설명에서 ${themes.join(', ')} 관련 사업 근거가 확인됩니다. 아래 원문 근거와 공시 링크에서 세부 내용을 확인할 수 있습니다.`;
	}
	return `${entry.name}은(는) ${industry} 분야의 기업입니다. 공식 공시를 확인했지만 현재 분류표 기준으로 확정할 만한 테마 근거가 충분하지 않아 테마 미분류로 표시합니다.`;
}

function fallbackProfile(entry: CompanyEntryInput, message: string): EvidenceCompanyProfile {
	const market = normalizeMarket(entry.market, entry.ticker);
	return {
		ticker: cleanTicker(entry.ticker),
		name: String(entry.name || entry.ticker),
		market: market as Market,
		currency: normalizeCurrency(entry.currency, market) as Currency,
		description: message,
		businessSummary: message,
		industry: '',
		officialIndustry: '',
		sector: '',
		country: market === 'KR' ? '대한민국' : '미국',
		mainBusiness: message,
		mainProducts: [],
		competitors: [],
		website: '',
		exchange: String(entry.exchange ?? ''),
		evidenceExcerpt: '',
		sourceType: 'NONE',
		sourceUrl: '',
		sourceDocumentId: '',
		sourceDate: '',
		confidence: 0,
		dataQuality: 'insufficient',
		reviewStatus: 'candidate',
		adminVerified: false,
		updatedAt: new Date().toISOString(),
	};
}

async function dartCorpCodes(): Promise<Map<string, DartCorpCodeRow>> {
	if (dartCorpCodesCache && Date.now() - dartCorpCodesCache.at < 24 * 60 * 60 * 1000) {
		return dartCorpCodesCache.rows;
	}

	const key = process.env.DART_API_KEY?.trim();
	if (!key) throw new Error('DART_API_KEY_NOT_CONFIGURED');

	const response = await fetchWithTimeout(
		`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(key)}`,
		{ headers: { 'User-Agent': 'seungjae-stock-app/2.0' } },
	);
	if (!response.ok) throw new Error(`DART_CORP_CODE_HTTP_${response.status}`);
	const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
	const xmlEntry = zip.getEntries().find((entry) => !entry.isDirectory && /\.xml$/i.test(entry.entryName));
	if (!xmlEntry) throw new Error('DART_CORP_CODE_XML_NOT_FOUND');
	const xml = decodeBuffer(xmlEntry.getData());
	const rows = new Map<string, DartCorpCodeRow>();

	for (const block of xml.match(/<list>[\s\S]*?<\/list>/gi) ?? []) {
		const stockCode = xmlTag(block, 'stock_code').replace(/\D/g, '');
		if (!/^\d{6}$/.test(stockCode)) continue;
		rows.set(stockCode, {
			corpCode: xmlTag(block, 'corp_code'),
			corpName: xmlTag(block, 'corp_name'),
			stockCode,
			modifyDate: xmlTag(block, 'modify_date'),
		});
	}

	dartCorpCodesCache = { at: Date.now(), rows };
	return rows;
}

async function fetchDartEvidence(entry: CompanyEntryInput): Promise<FilingEvidence> {
	const apiKey = process.env.DART_API_KEY?.trim();
	if (!apiKey) throw new Error('DART_API_KEY_NOT_CONFIGURED');

	const ticker = cleanTicker(entry.ticker);
	const corp = (await dartCorpCodes()).get(ticker);
	if (!corp?.corpCode) throw new Error('DART_CORP_CODE_NOT_FOUND');

	const company = await fetchJson<Record<string, unknown>>(
		`https://opendart.fss.or.kr/api/company.json?crtfc_key=${encodeURIComponent(apiKey)}&corp_code=${encodeURIComponent(corp.corpCode)}`,
		{ headers: { 'User-Agent': 'seungjae-stock-app/2.0' } },
	);
	if (String(company.status ?? '000') !== '000') {
		throw new Error(`DART_COMPANY_${String(company.status ?? 'ERROR')}`);
	}

	const now = new Date();
	const begin = `${now.getFullYear() - 4}0101`;
	const end = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
	const list = await fetchJson<{ status?: string; list?: Array<Record<string, unknown>> }>(
		`https://opendart.fss.or.kr/api/list.json?crtfc_key=${encodeURIComponent(apiKey)}&corp_code=${encodeURIComponent(corp.corpCode)}&bgn_de=${begin}&end_de=${end}&pblntf_ty=A&page_count=100&sort=date&sort_mth=desc`,
		{ headers: { 'User-Agent': 'seungjae-stock-app/2.0' } },
	);

	const reports = Array.isArray(list.list) ? list.list : [];
	const report = reports.find((row) => /사업보고서/.test(String(row.report_nm ?? ''))) ??
		reports.find((row) => /반기보고서|분기보고서/.test(String(row.report_nm ?? '')));
	if (!report) throw new Error('DART_PERIODIC_REPORT_NOT_FOUND');

	const receiptNo = String(report.rcept_no ?? '').trim();
	if (!/^\d{14}$/.test(receiptNo)) throw new Error('DART_RECEIPT_NO_INVALID');

	const documentResponse = await fetchWithTimeout(
		`https://opendart.fss.or.kr/api/document.xml?crtfc_key=${encodeURIComponent(apiKey)}&rcept_no=${encodeURIComponent(receiptNo)}`,
		{ headers: { 'User-Agent': 'seungjae-stock-app/2.0' } },
	);
	if (!documentResponse.ok) throw new Error(`DART_DOCUMENT_HTTP_${documentResponse.status}`);

	const zip = new AdmZip(Buffer.from(await documentResponse.arrayBuffer()));
	const candidates = zip.getEntries()
		.filter((zipEntry) => !zipEntry.isDirectory && /\.(xml|html?|xhtml)$/i.test(zipEntry.entryName))
		.map((zipEntry) => {
			const text = stripMarkup(decodeBuffer(zipEntry.getData()));
			const score = (/사업의\s*내용/.test(text) ? 1_000_000 : 0) + text.length;
			return { text, score };
		})
		.filter((item) => item.text.length > 100)
		.sort((a, b) => b.score - a.score);

	const fullText = candidates.slice(0, 8).map((item) => item.text).join('\n');
	const businessStart = fullText.search(/(?:Ⅱ|II|2)[.\s]*사업의\s*내용|사업의\s*내용/i);
	const sliced = businessStart >= 0 ? fullText.slice(businessStart) : fullText;
	const nextSection = sliced.slice(200).search(/(?:Ⅲ|III|3)[.\s]*(?:재무|재무에\s*관한\s*사항)|재무에\s*관한\s*사항/i);
	const businessText = (nextSection >= 0 ? sliced.slice(0, nextSection + 200) : sliced)
		.slice(0, MAX_EVIDENCE_TEXT)
		.trim();
	if (businessText.length < 120) throw new Error('DART_BUSINESS_TEXT_NOT_FOUND');

	return {
		industry: String(company.induty_code ?? '').trim(),
		country: '대한민국',
		website: String(company.hm_url ?? '').trim(),
		exchange: String(company.corp_cls ?? '').trim(),
		sourceType: 'DART',
		sourceUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receiptNo}`,
		sourceDocumentId: receiptNo,
		sourceDate: safeDate(report.rcept_dt),
		rawBusinessText: businessText,
		evidenceExcerpt: meaningfulSentences(businessText, 600),
		companyName: String(company.corp_name ?? corp.corpName ?? entry.name),
	};
}

function secHeaders(): Record<string, string> {
	const userAgent = process.env.SEC_USER_AGENT?.trim();
	if (!userAgent) throw new Error('SEC_USER_AGENT_NOT_CONFIGURED');
	return {
		'User-Agent': userAgent,
		Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
		'Accept-Encoding': 'gzip, deflate',
	};
}

async function secTickers(): Promise<Map<string, SecTickerRow>> {
	if (secTickersCache && Date.now() - secTickersCache.at < 24 * 60 * 60 * 1000) {
		return secTickersCache.rows;
	}

	const data = await fetchJson<Record<string, { cik_str?: number; ticker?: string; title?: string }>>(
		'https://www.sec.gov/files/company_tickers.json',
		{ headers: secHeaders() },
	);
	const rows = new Map<string, SecTickerRow>();
	for (const item of Object.values(data)) {
		const ticker = cleanTicker(item.ticker);
		const cik = Number(item.cik_str);
		if (!ticker || !Number.isFinite(cik)) continue;
		rows.set(ticker, { cik, ticker, title: String(item.title ?? ticker) });
	}
	secTickersCache = { at: Date.now(), rows };
	return rows;
}

function extractSecBusinessText(html: string, form: string): string {
	const text = stripMarkup(html).slice(0, 2_500_000);
	const normalized = text.replace(/\u00a0/g, ' ');
	const patterns = /20-F|40-F/i.test(form)
		? [/(?:^|\n|\s)item\s+4[.\s:-]+information\s+on\s+the\s+company/i, /information\s+on\s+the\s+company/i]
		: [/(?:^|\n|\s)item\s+1[.\s:-]+business/i, /item\s+1\s+business/i];
	let start = -1;
	for (const pattern of patterns) {
		start = normalized.search(pattern);
		if (start >= 0) break;
	}
	if (start < 0) start = 0;

	const sliced = normalized.slice(start);
	const endPatterns = /20-F|40-F/i.test(form)
		? [/item\s+5[.\s:-]+operating\s+and\s+financial\s+review/i, /item\s+4a/i]
		: [/item\s+1a[.\s:-]+risk\s+factors/i, /item\s+2[.\s:-]+properties/i];
	let end = -1;
	for (const pattern of endPatterns) {
		const found = sliced.slice(500).search(pattern);
		if (found >= 0) {
			end = found + 500;
			break;
		}
	}
	return (end > 0 ? sliced.slice(0, end) : sliced).slice(0, MAX_EVIDENCE_TEXT).trim();
}

async function fetchSecEvidence(entry: CompanyEntryInput): Promise<FilingEvidence> {
	const ticker = cleanTicker(entry.ticker);
	const tickerRow = (await secTickers()).get(ticker);
	if (!tickerRow) throw new Error('SEC_CIK_NOT_FOUND');
	const cikPadded = String(tickerRow.cik).padStart(10, '0');
	const submissions = await fetchJson<Record<string, any>>(
		`https://data.sec.gov/submissions/CIK${cikPadded}.json`,
		{ headers: secHeaders() },
	);

	const recent = submissions.filings?.recent ?? {};
	const forms: unknown[] = Array.isArray(recent.form) ? recent.form : [];
	const accessions: unknown[] = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
	const primaryDocuments: unknown[] = Array.isArray(recent.primaryDocument) ? recent.primaryDocument : [];
	const dates: unknown[] = Array.isArray(recent.filingDate) ? recent.filingDate : [];

	let filingIndex = -1;
	for (let i = 0; i < forms.length; i += 1) {
		if (/^(10-K|20-F|40-F)(?:\/A)?$/i.test(String(forms[i] ?? ''))) {
			filingIndex = i;
			break;
		}
	}
	if (filingIndex < 0) throw new Error('SEC_ANNUAL_REPORT_NOT_FOUND');

	const form = String(forms[filingIndex] ?? '10-K');
	const accession = String(accessions[filingIndex] ?? '');
	const primaryDocument = String(primaryDocuments[filingIndex] ?? '');
	if (!accession || !primaryDocument) throw new Error('SEC_PRIMARY_DOCUMENT_NOT_FOUND');

	const accessionPlain = accession.replace(/-/g, '');
	const filingUrl = `https://www.sec.gov/Archives/edgar/data/${tickerRow.cik}/${accessionPlain}/${primaryDocument}`;
	const response = await fetchWithTimeout(filingUrl, { headers: secHeaders() });
	if (!response.ok) throw new Error(`SEC_FILING_HTTP_${response.status}`);
	const html = await response.text();
	const businessText = extractSecBusinessText(html, form);
	if (businessText.length < 120) throw new Error('SEC_BUSINESS_TEXT_NOT_FOUND');

	return {
		industry: String(submissions.sicDescription ?? '').trim(),
		country: String(submissions.stateOfIncorporationDescription ?? submissions.stateOfIncorporation ?? '미국'),
		website: '',
		exchange: Array.isArray(submissions.exchanges) ? String(submissions.exchanges[0] ?? '') : String(entry.exchange ?? ''),
		sourceType: 'SEC',
		sourceUrl: filingUrl,
		sourceDocumentId: accession,
		sourceDate: safeDate(dates[filingIndex]),
		rawBusinessText: businessText,
		evidenceExcerpt: meaningfulSentences(businessText, 600),
		companyName: String(submissions.name ?? tickerRow.title ?? entry.name),
	};
}

async function readProfileFromSupabase(market: 'KR' | 'US', ticker: string): Promise<EvidenceCompanyProfile | null> {
	if (!hasSupabaseServerKey()) return null;
	try {
		const { data, error } = await getSupabase()
			.from('stock_company_profiles')
			.select('*')
			.eq('market', market)
			.eq('ticker', ticker)
			.maybeSingle();
		if (error || !data) return null;
		return {
			ticker: data.ticker,
			name: data.name,
			market: data.market,
			currency: data.currency,
			description: data.business_summary || data.description || '',
			businessSummary: data.business_summary || data.description || '',
			industry: data.official_industry || '',
			officialIndustry: data.official_industry || '',
			sector: data.sector || '',
			country: data.country || '',
			mainBusiness: data.business_summary || '',
			mainProducts: Array.isArray(data.main_products) ? data.main_products : [],
			competitors: Array.isArray(data.competitors) ? data.competitors : [],
			website: data.website || '',
			exchange: data.exchange || '',
			evidenceExcerpt: data.evidence_excerpt || '',
			sourceType: data.source_type || 'NONE',
			sourceUrl: data.source_url || '',
			sourceDocumentId: data.source_document_id || '',
			sourceDate: data.source_date || '',
			confidence: Number(data.confidence ?? 0),
			dataQuality: data.data_quality || 'insufficient',
			reviewStatus: data.review_status || 'candidate',
			adminVerified: Boolean(data.admin_verified),
			updatedAt: data.updated_at || '',
		} as EvidenceCompanyProfile;
	} catch {
		return null;
	}
}

async function writeProfileToSupabase(profile: EvidenceCompanyProfile): Promise<void> {
	if (!hasSupabaseServerKey()) return;
	const payload = {
		market: profile.market,
		ticker: profile.ticker,
		name: profile.name,
		currency: profile.currency,
		exchange: profile.exchange ?? '',
		country: profile.country ?? '',
		official_industry: profile.officialIndustry ?? profile.industry ?? '',
		sector: profile.sector ?? '',
		description: profile.description ?? '',
		business_summary: profile.businessSummary ?? profile.description ?? '',
		main_products: profile.mainProducts ?? [],
		competitors: profile.competitors ?? [],
		website: profile.website ?? '',
		evidence_excerpt: profile.evidenceExcerpt ?? '',
		source_type: profile.sourceType ?? 'NONE',
		source_url: profile.sourceUrl ?? '',
		source_document_id: profile.sourceDocumentId ?? '',
		source_date: profile.sourceDate || null,
		confidence: profile.confidence ?? 0,
		data_quality: profile.dataQuality ?? 'insufficient',
		review_status: profile.reviewStatus ?? 'candidate',
		admin_verified: Boolean(profile.adminVerified),
		updated_at: profile.updatedAt ?? new Date().toISOString(),
	};
	const { error } = await getSupabase()
		.from('stock_company_profiles')
		.upsert(payload, { onConflict: 'market,ticker' });
	if (error) throw error;
}

async function replaceRelationsInSupabase(
	market: 'KR' | 'US',
	ticker: string,
	relations: ThemeRelationRecord[],
): Promise<void> {
	if (!hasSupabaseServerKey()) return;
	const supabase = getSupabase();
	const { data: verifiedRows, error: verifiedError } = await supabase
		.from('stock_theme_relations')
		.select('theme_key')
		.eq('market', market)
		.eq('ticker', ticker)
		.eq('admin_verified', true);
	if (verifiedError) throw verifiedError;
	const verifiedKeys = new Set((verifiedRows ?? []).map((row: any) => String(row.theme_key)));

	const { error: deleteError } = await supabase
		.from('stock_theme_relations')
		.delete()
		.eq('market', market)
		.eq('ticker', ticker)
		.eq('admin_verified', false);
	if (deleteError) throw deleteError;

	const writable = relations.filter((relation) => !verifiedKeys.has(relation.themeKey));
	if (!writable.length) return;
	const rows = writable.map((relation) => ({
		market: relation.market,
		ticker: relation.ticker,
		name: relation.name,
		currency: relation.currency,
		theme_key: relation.themeKey,
		theme_label: relation.themeLabel,
		relation_level: relation.relationLevel,
		reason: relation.reason,
		evidence: relation.evidence,
		confidence: relation.confidence,
		source_type: relation.sourceType,
		source_url: relation.sourceUrl,
		source_document_id: relation.sourceDocumentId,
		source_date: relation.sourceDate || null,
		review_status: relation.reviewStatus,
		admin_verified: relation.adminVerified,
		updated_at: relation.updatedAt,
	}));
	const { error } = await supabase
		.from('stock_theme_relations')
		.upsert(rows, { onConflict: 'market,ticker,theme_key' });
	if (error) throw error;
}

async function listRelationsFromSupabase(market: 'KR' | 'US'): Promise<ThemeRelationRecord[] | null> {
	if (!hasSupabaseServerKey()) return null;
	try {
		const result: ThemeRelationRecord[] = [];
		const pageSize = 1000;
		for (let from = 0; from < 20_000; from += pageSize) {
			const { data, error } = await getSupabase()
				.from('stock_theme_relations')
				.select('*')
				.eq('market', market)
				.neq('review_status', 'rejected')
				.order('confidence', { ascending: false })
				.range(from, from + pageSize - 1);
			if (error) return null;
			for (const row of data ?? []) {
				result.push({
					market: row.market,
					ticker: row.ticker,
					name: row.name,
					currency: row.currency,
					themeKey: row.theme_key,
					themeLabel: row.theme_label,
					relationLevel: row.relation_level,
					reason: row.reason,
					evidence: row.evidence,
					confidence: Number(row.confidence ?? 0),
					sourceType: row.source_type,
					sourceUrl: row.source_url,
					sourceDocumentId: row.source_document_id,
					sourceDate: row.source_date || '',
					reviewStatus: row.review_status,
					adminVerified: Boolean(row.admin_verified),
					updatedAt: row.updated_at,
				});
			}
			if ((data ?? []).length < pageSize) break;
		}
		return result;
	} catch {
		return null;
	}
}

async function persistProfileAndRelations(
	profile: EvidenceCompanyProfile,
	relations: ThemeRelationRecord[],
): Promise<void> {
	const market = normalizeMarket(profile.market, profile.ticker);
	const ticker = cleanTicker(profile.ticker);
	const cache = await loadLocalCache();
	cache.profiles[profileKey(market, ticker)] = profile;

	for (const [key, relation] of Object.entries(cache.relations)) {
		if (relation.market === market && relation.ticker === ticker && !relation.adminVerified) {
			delete cache.relations[key];
		}
	}
	for (const relation of relations) {
		const key = relationKey(relation);
		const verified = cache.relations[key];
		if (verified?.adminVerified && verified.reviewStatus === 'approved') continue;
		cache.relations[key] = relation;
	}
	await persistLocalCache();

	try {
		await writeProfileToSupabase(profile);
		await replaceRelationsInSupabase(market, ticker, relations);
	} catch (error) {
		console.error('[company-intelligence] Supabase persistence failed:', error);
	}
}

async function buildOfficialProfile(entry: CompanyEntryInput): Promise<{
	profile: EvidenceCompanyProfile;
	relations: ThemeRelationRecord[];
}> {
	const market = normalizeMarket(entry.market, entry.ticker);
	const evidence = market === 'KR' ? await fetchDartEvidence(entry) : await fetchSecEvidence(entry);
	const relations = classifyThemes(entry, evidence);
	const summary = makeKoreanSummary(entry, evidence, relations);
	const confidence = Math.min(98, 70 + Math.min(20, relations.length * 3));
	const profile: EvidenceCompanyProfile = {
		ticker: cleanTicker(entry.ticker),
		name: evidence.companyName || String(entry.name || entry.ticker),
		market: market as Market,
		currency: normalizeCurrency(entry.currency, market) as Currency,
		description: summary,
		businessSummary: summary,
		industry: evidence.industry,
		officialIndustry: evidence.industry,
		sector: relations[0]?.themeLabel ?? '',
		country: evidence.country,
		mainBusiness: summary,
		mainProducts: productsFromRelations(relations),
		competitors: [],
		website: evidence.website,
		exchange: evidence.exchange || String(entry.exchange ?? ''),
		evidenceExcerpt: evidence.evidenceExcerpt,
		sourceType: evidence.sourceType,
		sourceUrl: evidence.sourceUrl,
		sourceDocumentId: evidence.sourceDocumentId,
		sourceDate: evidence.sourceDate,
		confidence,
		dataQuality: evidence.rawBusinessText.length >= 500 ? 'official' : 'partial',
		reviewStatus: 'candidate',
		adminVerified: false,
		updatedAt: new Date().toISOString(),
	};
	return { profile, relations };
}

async function cachedProfile(entry: CompanyEntryInput): Promise<EvidenceCompanyProfile | null> {
	const market = normalizeMarket(entry.market, entry.ticker);
	const ticker = cleanTicker(entry.ticker);
	const db = await readProfileFromSupabase(market, ticker);
	if (db && isFresh(db)) return db;
	const cache = await loadLocalCache();
	const local = cache.profiles[profileKey(market, ticker)] ?? null;
	return local && isFresh(local) ? local : db ?? local;
}

async function getProfile(entry: CompanyEntryInput, force = false): Promise<EvidenceCompanyProfile> {
	const market = normalizeMarket(entry.market, entry.ticker);
	const ticker = cleanTicker(entry.ticker);
	const normalizedEntry: CompanyEntryInput = {
		...entry,
		ticker,
		market,
		currency: normalizeCurrency(entry.currency, market),
		name: String(entry.name || ticker),
	};

	if (!force) {
		const existing = await cachedProfile(normalizedEntry);
		if (existing && (isFresh(existing) || existing.adminVerified)) return existing;
	}

	try {
		const built = await buildOfficialProfile(normalizedEntry);
		await persistProfileAndRelations(built.profile, built.relations);
		return built.profile;
	} catch (error) {
		const existing = await cachedProfile(normalizedEntry);
		if (existing) return existing;
		const message = error instanceof Error ? error.message : String(error);
		const honest = fallbackProfile(
			normalizedEntry,
			market === 'KR'
				? `공식 DART 사업보고서 기반 기업개요를 아직 불러오지 못했습니다. (${message})`
				: `공식 SEC 연차보고서 기반 기업개요를 아직 불러오지 못했습니다. (${message})`,
		);
		await persistProfileAndRelations(honest, []);
		return honest;
	}
}

async function listRelations(market: 'KR' | 'US'): Promise<ThemeRelationRecord[]> {
	const fromDb = await listRelationsFromSupabase(market);
	if (fromDb) return fromDb;
	const cache = await loadLocalCache();
	return Object.values(cache.relations)
		.filter((relation) => relation.market === market && relation.reviewStatus !== 'rejected')
		.sort((a, b) => b.confidence - a.confidence);
}

async function listProfiles(market: 'KR' | 'US'): Promise<EvidenceCompanyProfile[]> {
	const cache = await loadLocalCache();
	return Object.values(cache.profiles).filter((profile) => normalizeMarket(profile.market, profile.ticker) === market);
}

async function getUsOfficialUniverse(): Promise<CompanyEntryInput[]> {
	const rows = await secTickers();
	return Array.from(rows.values())
		.filter((row) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(row.ticker))
		.map((row) => ({
			ticker: row.ticker,
			name: row.title,
			market: 'US',
			currency: 'USD',
			assetType: 'STOCK',
			exchange: row.exchange || 'US',
		}))
		.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

async function getStatus(market: 'KR' | 'US'): Promise<CompanyIntelligenceStatus> {
	const cache = await loadLocalCache();
	const profiles = await listProfiles(market);
	const relations = await listRelations(market);
	const classified = new Set(relations.map((relation) => relation.ticker));
	const progress = cache.progress[market];
	return {
		market,
		universeCount: progress.universeCount,
		classifiedCount: classified.size,
		profileCount: profiles.length,
		relationCount: relations.length,
		cursor: progress.cursor,
		running: progress.running || Boolean(jobs[market]),
		lastRunAt: progress.lastRunAt,
		lastError: progress.lastError,
		storage: hasSupabaseServerKey() ? 'supabase' : 'local',
	};
}

async function updateProgress(market: 'KR' | 'US', patch: Partial<CacheProgress>): Promise<void> {
	const cache = await loadLocalCache();
	cache.progress[market] = { ...cache.progress[market], ...patch };
	await persistLocalCache();
}

async function processUniverse(
	market: 'KR' | 'US',
	universe: CompanyEntryInput[],
	options: { limit?: number; reset?: boolean } = {},
): Promise<void> {
	const cache = await loadLocalCache();
	let cursor = options.reset ? 0 : Math.max(0, cache.progress[market].cursor || 0);
	if (cursor >= universe.length) cursor = 0;
	const max = Math.max(1, Math.min(options.limit ?? universe.length, universe.length));
	let processed = 0;

	await updateProgress(market, {
		universeCount: universe.length,
		cursor,
		running: true,
		lastError: null,
	});

	try {
		while (cursor < universe.length && processed < max) {
			const entry = universe[cursor];
			await getProfile(entry, options.reset === true);
			cursor += 1;
			processed += 1;
			await updateProgress(market, {
				universeCount: universe.length,
				cursor,
				running: true,
				lastRunAt: new Date().toISOString(),
			});
			// SEC의 공정 접근 정책과 DART 호출 부하를 고려한 완만한 순차 처리.
			await new Promise((resolve) => setTimeout(resolve, market === 'US' ? 140 : 90));
		}
	} catch (error) {
		await updateProgress(market, {
			running: false,
			lastError: error instanceof Error ? error.message : String(error),
			lastRunAt: new Date().toISOString(),
		});
		throw error;
	}

	await updateProgress(market, {
		universeCount: universe.length,
		cursor: cursor >= universe.length ? 0 : cursor,
		running: false,
		lastError: null,
		lastRunAt: new Date().toISOString(),
	});
}

function startBackgroundRebuild(
	market: 'KR' | 'US',
	universe: CompanyEntryInput[],
	options: { limit?: number; reset?: boolean } = {},
): { started: boolean; message: string } {
	if (jobs[market]) return { started: false, message: `${market} 기업·테마 수집 작업이 이미 실행 중입니다.` };

	jobs[market] = processUniverse(market, universe, options)
		.catch((error) => {
			console.error(`[company-intelligence] ${market} rebuild failed:`, error);
		})
		.finally(() => {
			jobs[market] = null;
		});

	return { started: true, message: `${market} 공식 공시 기반 기업·테마 수집을 시작했습니다.` };
}

async function reviewRelation(input: {
	market: 'KR' | 'US';
	ticker: string;
	themeKey: string;
	action: 'approve' | 'reject';
	relationLevel?: ThemeRelationLevel;
	reason?: string;
}): Promise<ThemeRelationRecord | null> {
	const cache = await loadLocalCache();
	const key = `${input.market}:${cleanTicker(input.ticker)}:${input.themeKey}`;
	const existing = cache.relations[key];
	if (!existing) return null;

	const updated: ThemeRelationRecord = {
		...existing,
		relationLevel: input.relationLevel ?? existing.relationLevel,
		reason: input.reason?.trim() || existing.reason,
		reviewStatus: input.action === 'approve' ? 'approved' : 'rejected',
		adminVerified: input.action === 'approve',
		updatedAt: new Date().toISOString(),
	};
	cache.relations[key] = updated;
	await persistLocalCache();

	if (hasSupabaseServerKey()) {
		const { error } = await getSupabase()
			.from('stock_theme_relations')
			.update({
				relation_level: updated.relationLevel,
				reason: updated.reason,
				review_status: updated.reviewStatus,
				admin_verified: updated.adminVerified,
				updated_at: updated.updatedAt,
			})
			.eq('market', updated.market)
			.eq('ticker', updated.ticker)
			.eq('theme_key', updated.themeKey);
		if (error) throw error;
	}
	return updated;
}

export const CompanyIntelligenceService = {
	getProfile,
	listRelations,
	listProfiles,
	getStatus,
	startBackgroundRebuild,
	reviewRelation,
	getUsOfficialUniverse,
};
