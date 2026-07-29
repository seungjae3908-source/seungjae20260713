import { Router, type IRouter } from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MarketDataService } from "../services/market-data.service";
import {
	placeKiwoomDomesticOrder,
	placeKiwoomUsOrder,
	getKiwoomShortSellingRaw,
	type KiwoomUsExchange,
} from "../providers/kiwoom";
import { FilingService } from "../services/filing.service";
import {
	SpecialFeedService,
	type SpecialFeedMarket,
} from "../services/special-feed.service";
import { SignalService } from "../services/signal.service";
import { computeIndicators } from "../sample/indicators";
import { computeScores } from "../sample/scores";
import { scoreToRating } from "../sample/rating";
import { deliverMemberNotification } from "../services/notification.service";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth";
import {
	getCorpCode as getDartProviderCorpCode,
	getFinancials as getDartProviderFinancials,
} from "../providers/dart";

const router: IRouter = Router();

type TimedCacheEntry = { expiresAt: number; value: unknown };
const liveDataCache = new Map<string, TimedCacheEntry>();

async function withLiveCache<T>(
	key: string,
	ttlMs: number,
	loader: () => Promise<T>,
): Promise<T> {
	const cached = liveDataCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.value as T;

	const value = await loader();
	liveDataCache.set(key, { expiresAt: Date.now() + ttlMs, value });

	if (liveDataCache.size > 300) {
		for (const [cacheKey, entry] of liveDataCache) {
			if (entry.expiresAt <= Date.now()) liveDataCache.delete(cacheKey);
		}
	}
	return value;
}


// GET /api/stocks/server-ip
// Replit 서버가 외부 API에 접속할 때 사용되는 현재 공인 IP를 확인합니다.
router.get("/server-ip", requireAdmin, async (_req, res) => {
	const providers = [
		"https://api.ipify.org?format=json",
		"https://ifconfig.me/all.json",
		"https://checkip.amazonaws.com",
	];

	const attempts: Array<{
		provider: string;
		ok: boolean;
		status?: number;
		error?: string;
	}> = [];

	for (const provider of providers) {
		try {
			const response = await fetch(provider, {
				headers: {
					Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
					"User-Agent": "seungjae-stock-app/1.0",
				},
			});

			if (!response.ok) {
				attempts.push({
					provider,
					ok: false,
					status: response.status,
				});
				continue;
			}

			const raw = (await response.text()).trim();

			let ip = raw;

			try {
				const parsed = JSON.parse(raw) as Record<string, unknown>;

				ip = String(
					parsed.ip ??
						parsed.ip_addr ??
						parsed.address ??
						parsed.ipv4 ??
						parsed.ipv6 ??
						"",
				).trim();
			} catch {
				// 텍스트 응답이면 그대로 사용합니다.
			}

			const matchedIp =
				ip.match(
					/(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}/,
				)?.[0] ?? "";

			if (!matchedIp) {
				attempts.push({
					provider,
					ok: false,
					error: "IP_ADDRESS_NOT_FOUND",
				});
				continue;
			}

			res.setHeader("Cache-Control", "no-store");

			res.json({
				ok: true,
				ip: matchedIp,
				provider,
				checkedAt: new Date().toISOString(),
				note:
					"이 값은 현재 실행 중인 Replit 서버의 외부 요청 IP입니다. 서버 재시작·재배포·실행 환경 변경 시 달라질 수 있습니다.",
			});
			return;
		} catch (error) {
			attempts.push({
				provider,
				ok: false,
				error:
					error instanceof Error
						? error.message
						: "UNKNOWN_SERVER_IP_ERROR",
			});
		}
	}

	res.status(502).json({
		ok: false,
		error: "SERVER_IP_LOOKUP_FAILED",
		attempts,
	});
});

function normalizeTicker(value: unknown) {
	return String(value ?? "")
		.trim()
		.toUpperCase();
}

// GET /api/stocks/special-feed
// 주식·코인의 뉴스·공시·차트신호를 1주일 최신정보와 이후 보관함으로 제공합니다.
router.get("/special-feed", async (req, res) => {
	const asset = String(req.query.asset ?? "stock").toLowerCase() === "coin" ? "coin" : "stock";
	const rawMarket = String(req.query.market ?? (asset === "coin" ? "spot" : "KR"));
	const market: SpecialFeedMarket =
		asset === "coin"
			? rawMarket.toLowerCase() === "futures"
				? "futures"
				: "spot"
			: rawMarket.toUpperCase() === "US"
				? "US"
				: "KR";
	const limit = Math.max(1, Math.min(2_000, Math.trunc(Number(req.query.limit ?? 500)) || 500));

	res.setHeader("Cache-Control", "no-store, max-age=0");

	try {
		const result = await SpecialFeedService.getFeed(market, limit);
		res.json(result);
	} catch (error) {
		console.error("special feed route error:", error);
		res.status(502).json({
			ok: false,
			asset,
			market,
			items: [],
			count: 0,
			updatedAt: new Date().toISOString(),
			message: "특이정보를 불러오지 못했습니다.",
		});
	}
});

function normalizeTimeframe(value: unknown) {
	const raw = String(value ?? "1D").trim();

	if (!raw) return "1D";

	return raw;
}

function decodeXml(value: string) {
	return value
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.trim();
}

function xmlTag(block: string, tag: string) {
	const match = block.match(
		new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i"),
	);
	return match ? decodeXml(match[1]) : "";
}

function companyNameFromProfile(profile: any, ticker: string) {
	return String(
		profile?.name ??
			profile?.companyName ??
			profile?.corp_name ??
			profile?.company?.name ??
			ticker,
	).trim();
}

let dartCorpMapCache: Map<string, string> | null = null;

async function getDartCorpCode(ticker: string, apiKey: string) {
try {
const sharedCorpCode = await getDartProviderCorpCode(ticker);
if (sharedCorpCode) return sharedCorpCode;
} catch {
//  DART     ZIP   .
}

if (!dartCorpMapCache) {
const response = await fetch(
"https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=" +
encodeURIComponent(apiKey),
);

if (!response.ok) {
throw new Error("DART_CORP_CODE_HTTP_" + response.status);
}

const zipBytes = Buffer.from(await response.arrayBuffer());

const { mkdtemp, writeFile, rm } =
await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { execFileSync } = await import("node:child_process");
const tempDirectory = await mkdtemp(
join(tmpdir(), "dart-corp-code-"),
);
const zipPath = join(tempDirectory, "corpCode.zip");

try {
await writeFile(zipPath, zipBytes);

const xml = execFileSync(
"python3",
[
"-c",
[
"import sys, zipfile",
"z = zipfile.ZipFile(sys.argv[1])",
"name = next(n for n in z.namelist() if n.lower().endswith('.xml'))",
"sys.stdout.buffer.write(z.read(name))",
].join("; "),
zipPath,
],
{
encoding: "utf8",
maxBuffer: 80 * 1024 * 1024,
},
);

const map = new Map<string, string>();

for (const block of xml.match(/<list>[\s\S]*?<\/list>/g) ?? []) {
const stockCode = xmlTag(block, "stock_code").trim();
const corpCode = xmlTag(block, "corp_code").trim();

if (stockCode && corpCode) {
map.set(stockCode, corpCode);
}
}

if (!map.size) {
throw new Error("DART_CORP_CODE_MAP_EMPTY");
}

dartCorpMapCache = map;
} finally {
await rm(tempDirectory, {
recursive: true,
force: true,
});
}
}

return dartCorpMapCache.get(ticker) ?? "";
}

async function fetchDartFilings(ticker: string, allHistory = false) {
	const apiKey = String(process.env.DART_API_KEY ?? "").trim();
	const ymd = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, "");
	const endDate = new Date();
	const startDate = allHistory
		? new Date("1990-01-01T00:00:00+09:00")
		: new Date(endDate.getTime() - 3 * 365 * 24 * 60 * 60 * 1000);
	const fallback = {
		title: "DART에서 " + ticker + " 공시 전체보기",
		report_nm: "공식 전자공시 검색",
		date: "실시간",
		rcept_dt: "",
		url: "https://dart.fss.or.kr/dsab001/main.do",
		source: "DART",
	};

	if (!apiKey || !/^\d{6}$/.test(ticker)) return [];

	const corpCode = await getDartCorpCode(ticker, apiKey);
	if (!corpCode) return [fallback];

	const items: any[] = [];
	let pageNo = 1;
	let totalPage = 1;

	do {
		const query = new URLSearchParams({
			crtfc_key: apiKey,
			corp_code: corpCode,
			bgn_de: ymd(startDate),
			end_de: ymd(endDate),
			last_reprt_at: "N",
			page_no: String(pageNo),
			page_count: "100",
			sort: "date",
			sort_mth: "desc",
		});
		const response = await fetch(
			"https://opendart.fss.or.kr/api/list.json?" + query.toString(),
		);
		if (!response.ok) throw new Error("DART_LIST_HTTP_" + response.status);
		const data: any = await response.json();

		if (data?.status && data.status !== "000" && data.status !== "013") {
			throw new Error(`DART_LIST_${String(data.status)}:${String(data.message ?? "")}`);
		}
		if (Array.isArray(data?.list)) items.push(...data.list);

		totalPage = Math.max(1, Number(data?.total_page ?? 1) || 1);
		pageNo += 1;
	} while (pageNo <= totalPage && (allHistory || pageNo <= 1));

	const unique = new Map<string, any>();
	for (const item of items) {
		const key = String(item?.rcept_no ?? `${item?.rcept_dt}:${item?.report_nm}`);
		if (!unique.has(key)) unique.set(key, item);
	}

	const result = [...unique.values()].map((item: any) => ({
		...item,
		title: item.report_nm,
		date: item.rcept_dt,
		url: item.rcept_no
			? "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + item.rcept_no
			: fallback.url,
		source: "DART",
	}));

	const grouped = new Map<string, any>();
	for (const item of result) {
		const normalizedTitle = String(item.report_nm ?? item.title ?? "")
			.toLowerCase()
			.replace(/\[[^\]]*\]|\([^)]*\)/g, "")
			.replace(/정정|첨부정정|기재정정/g, "")
			.replace(/[^0-9a-z가-힣]/g, "");
		const existing = grouped.get(normalizedTitle);
		if (existing) existing.relatedCount = Number(existing.relatedCount ?? 1) + 1;
		else grouped.set(normalizedTitle, { ...item, relatedCount: 1 });
	}

	const groupedItems = [...grouped.values()];
	return allHistory ? groupedItems : groupedItems.slice(0, 5);
}

interface SecTickerEntry {
	cik_str?: number | string;
	ticker?: string;
	title?: string;
}

let secTickerMapCache: Map<string, string> | null = null;

function secHeaders() {
	return {
		Accept: "application/json",
		"User-Agent":
			String(process.env.SEC_USER_AGENT ?? "").trim() ||
			"seungjae-stock-app/1.0 seungjae3908@gmail.com",
	};
}

async function getSecCik(ticker: string) {
	if (!secTickerMapCache) {
		const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
			headers: secHeaders(),
		});
		if (!response.ok) throw new Error("SEC_TICKERS_HTTP_" + response.status);
		const data = (await response.json()) as Record<string, SecTickerEntry>;
		const map = new Map<string, string>();
		for (const entry of Object.values(data)) {
			const symbol = String(entry?.ticker ?? "").trim().toUpperCase();
			const cik = String(entry?.cik_str ?? "").replace(/\D/g, "").padStart(10, "0");
			if (symbol && cik) map.set(symbol, cik);
		}
		secTickerMapCache = map;
	}
	return secTickerMapCache.get(ticker.trim().toUpperCase()) ?? "";
}

function secColumnRows(source: any, cik: string) {
	const count = Math.max(
		...(Object.values(source ?? {}) as unknown[]).map((value) =>
			Array.isArray(value) ? value.length : 0,
		),
		0,
	);
	const rows: any[] = [];
	const cikNoZero = String(Number(cik));

	for (let index = 0; index < count; index += 1) {
		const accessionNumber = String(source?.accessionNumber?.[index] ?? "");
		const primaryDocument = String(source?.primaryDocument?.[index] ?? "");
		const filingDate = String(source?.filingDate?.[index] ?? "");
		const form = String(source?.form?.[index] ?? "");
		if (!accessionNumber || !filingDate) continue;

		rows.push({
			accessionNumber,
			filingDate,
			date: filingDate,
			acceptedAt: source?.acceptanceDateTime?.[index] ?? filingDate,
			form,
			title: form ? `${form} 제출` : "SEC 공시",
			primaryDocument,
			reportDate: source?.reportDate?.[index] ?? "",
			url: primaryDocument
				? `https://www.sec.gov/Archives/edgar/data/${cikNoZero}/${accessionNumber.replace(/-/g, "")}/${primaryDocument}`
				: `https://www.sec.gov/Archives/edgar/data/${cikNoZero}/${accessionNumber.replace(/-/g, "")}/`,
			source: "SEC EDGAR",
		});
	}
	return rows;
}

async function fetchSecFilings(ticker: string) {
	const cik = await getSecCik(ticker);
	if (!cik) return [];

	const response = await fetch(
		`https://data.sec.gov/submissions/CIK${cik}.json`,
		{ headers: secHeaders() },
	);
	if (!response.ok) throw new Error("SEC_SUBMISSIONS_HTTP_" + response.status);
	const data: any = await response.json();
	const items = secColumnRows(data?.filings?.recent ?? {}, cik);

	for (const file of Array.isArray(data?.filings?.files) ? data.filings.files : []) {
		const name = String(file?.name ?? "").trim();
		if (!name) continue;
		const historyResponse = await fetch(
			`https://data.sec.gov/submissions/${encodeURIComponent(name)}`,
			{ headers: secHeaders() },
		);
		if (!historyResponse.ok) continue;
		const history: any = await historyResponse.json();
		items.push(...secColumnRows(history, cik));
	}

	const unique = new Map<string, any>();
	for (const item of items) {
		if (!unique.has(item.accessionNumber)) unique.set(item.accessionNumber, item);
	}
	return [...unique.values()].sort((a, b) =>
		String(b.filingDate).localeCompare(String(a.filingDate)),
	);
}

async function fetchAllFilings(ticker: string, allHistory = false) {
	return /^\d{6}$/.test(ticker)
		? fetchDartFilings(ticker, allHistory)
		: fetchSecFilings(ticker).then((items) => allHistory ? items : items.slice(0, 5));
}

function metricRow(rows: string[][], patterns: RegExp[]) {
	return rows.find((cells) => patterns.some((pattern) => pattern.test(cells[0] ?? "")));
}

function financialNumber(value: unknown): number | null {
	if (value == null) return null;
	const raw = String(value)
		.replace(/&#40;|\$#40;|#40;/gi, "(")
		.replace(/&#41;|\$#41;|#41;/gi, ")")
		.replace(/&nbsp;|&#160;/gi, " ")
		.replace(/,/g, "")
		.replace(/%/g, "")
		.trim();
	if (!raw || raw === "-" || raw === "N/A") return null;
	const negative = /^\(.*\)$/.test(raw);
	const normalized = raw.replace(/[()]/g, "").replace(/[^0-9+\-.]/g, "");
	const parsed = Number(normalized);
	if (!Number.isFinite(parsed) || parsed === 0) return null;
	return negative ? -Math.abs(parsed) : parsed;
}

function periodIsAvailable(period: string) {
	const clean = period.replace(/\(E\)/gi, "").replace(/[^0-9.]/g, "");
	const match = clean.match(/^(20\d{2})(?:\.(\d{2}))?/);
	if (!match) return true;
	const year = Number(match[1]);
	const month = Number(match[2] ?? 12);
	const now = new Date();
	return year < now.getFullYear() || (year === now.getFullYear() && month <= now.getMonth() + 1);
}

function buildNaverFinancialRows(html: string) {
	const table = financeTableRows(html);
	const periodCells = table.find((cells) => cells.filter((cell) => /^20\d{2}\.\d{2}/.test(cell)).length >= 4) ?? [];
	const periods = periodCells.filter((cell) => /^20\d{2}\.\d{2}/.test(cell));
	if (!periods.length) return { annual: [], quarterly: [], ratios: {}, marketCap: null };

	const marketCapMatch = html.match(/id=["']_market_sum["'][^>]*>([\s\S]*?)<\/em>/i);
	const marketCapHundredMillion = financialNumber(
		marketCapMatch ? cleanFinanceCell(marketCapMatch[1]) : null,
	);
	const marketCap = marketCapHundredMillion == null
		? null
		: marketCapHundredMillion * 100_000_000;

	const definitions = {
		revenue: [/^매출액/, /^영업수익/],
		operatingIncome: [/^영업이익/],
		netIncome: [/^당기순이익/, /^순이익/],
		assets: [/^자산총계/],
		liabilities: [/^부채총계/],
		equity: [/^자본총계/],
		capitalStock: [/^자본금/],
		cash: [/^현금및현금성자산/, /^현금 및 현금성자산/],
		operatingCashFlow: [/^영업활동.*현금흐름/],
		investingCashFlow: [/^투자활동.*현금흐름/],
		financingCashFlow: [/^재무활동.*현금흐름/],
		roe: [/^ROE/],
		per: [/^PER/],
		pbr: [/^PBR/],
	} as const;
	const metricRows = Object.fromEntries(
		Object.entries(definitions).map(([key, patterns]) => [key, metricRow(table, [...patterns])]),
	) as Record<string, string[] | undefined>;

	const valuesAt = (key: string, index: number) =>
		financialNumber(metricRows[key]?.[index + 1]);
	const rows = periods.filter(periodIsAvailable).map((period, index) => ({
		period: period.replace(/&#40;|\$#40;|#40;/gi, "(").replace(/&#41;|\$#41;|#41;/gi, ")").replace(/\(E\)/g, "").replace(/<[^>]+>/g, "").trim(),
		revenue: valuesAt("revenue", index),
		operatingIncome: valuesAt("operatingIncome", index),
		netIncome: valuesAt("netIncome", index),
		assets: valuesAt("assets", index),
		liabilities: valuesAt("liabilities", index),
		equity: valuesAt("equity", index),
		capitalStock: valuesAt("capitalStock", index),
		cash: valuesAt("cash", index),
		operatingCashFlow: valuesAt("operatingCashFlow", index),
		investingCashFlow: valuesAt("investingCashFlow", index),
		financingCashFlow: valuesAt("financingCashFlow", index),
	}));
	const annual = rows.filter((row) => /\.12/.test(row.period)).slice(0, 5);
	const quarterly = rows.filter((row) => !/\.12/.test(row.period)).slice(0, 6);
	const latestIndex = 0;

	return {
		annual,
		yearly: annual,
		quarterly,
		quarters: quarterly,
		ratios: {
			roe: valuesAt("roe", latestIndex),
			per: valuesAt("per", latestIndex),
			pbr: valuesAt("pbr", latestIndex),
			debtRatio: annual[0]?.liabilities != null && annual[0]?.equity ? (annual[0].liabilities / annual[0].equity) * 100 : null,
		},
		marketCap,
		source: "NAVER_FINANCE",
		updatedAt: new Date().toISOString(),
	};
}

async function fetchNaverFinancials(ticker: string) {
	const response = await fetch(
		`https://finance.naver.com/item/main.naver?code=${encodeURIComponent(ticker)}`,
		{ headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.naver.com/" } },
	);
	if (!response.ok) throw new Error("NAVER_FINANCIAL_HTTP_" + response.status);
	return buildNaverFinancialRows(await response.text());
}

const DART_REPORTS = [
	{ code: "11013", month: "03", label: "1분기" },
	{ code: "11012", month: "06", label: "반기" },
	{ code: "11014", month: "09", label: "3분기" },
	{ code: "11011", month: "12", label: "연간" },
] as const;

function dartAccountValue(list: any[], patterns: RegExp[]) {
	const candidates = list.filter((item) => patterns.some((pattern) => pattern.test(`${item?.account_id ?? ""} ${item?.account_nm ?? ""}`)));
	const consolidated = candidates.find((item) => String(item?.fs_div ?? "").toUpperCase() === "CFS") ?? candidates[0];
	return financialNumber(consolidated?.thstrm_amount ?? consolidated?.thstrm_add_amount);
}

async function fetchDartFinancials(ticker: string) {
	const apiKey = String(process.env.DART_API_KEY ?? "").trim();
	if (!apiKey) throw new Error("DART_API_KEY_MISSING");
	const corpCode = await getDartCorpCode(ticker, apiKey);
	if (!corpCode) throw new Error("DART_CORP_CODE_NOT_FOUND");
	const now = new Date();
	const annual: any[] = [];
	const quarterly: any[] = [];

	for (let year = now.getFullYear(); year >= now.getFullYear() - 5; year -= 1) {
		for (const report of DART_REPORTS) {
			const periodEnd = new Date(year, Number(report.month), 0, 23, 59, 59);
			if (periodEnd.getTime() > now.getTime()) continue;
			const query = new URLSearchParams({ crtfc_key: apiKey, corp_code: corpCode, bsns_year: String(year), reprt_code: report.code, fs_div: "CFS" });
			const response = await fetch(`https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?${query.toString()}`);
			if (!response.ok) continue;
			const data: any = await response.json();
			if (data?.status !== "000" || !Array.isArray(data?.list)) continue;
			const list = data.list;
			const row = {
				period: `${year}.${report.month}`,
				periodLabel: `${year}년 ${report.label}`,
				revenue: dartAccountValue(list, [/Revenue/i, /매출액/, /영업수익/]),
				operatingIncome: dartAccountValue(list, [/OperatingIncomeLoss/i, /영업이익/]),
				netIncome: dartAccountValue(list, [/ProfitLoss/i, /당기순이익/, /분기순이익/, /반기순이익/]),
				assets: dartAccountValue(list, [/^ifrs-full_Assets$/i, /자산총계/]),
				liabilities: dartAccountValue(list, [/^ifrs-full_Liabilities$/i, /부채총계/]),
				equity: dartAccountValue(list, [/Equity/i, /자본총계/]),
				capitalStock: dartAccountValue(list, [/IssuedCapital/i, /자본금/]),
				cash: dartAccountValue(list, [/CashAndCashEquivalents/i, /현금및현금성자산/, /현금 및 현금성자산/]),
				operatingCashFlow: dartAccountValue(list, [/CashFlowsFromUsedInOperatingActivities/i, /영업활동.*현금흐름/]),
				investingCashFlow: dartAccountValue(list, [/CashFlowsFromUsedInInvestingActivities/i, /투자활동.*현금흐름/]),
				financingCashFlow: dartAccountValue(list, [/CashFlowsFromUsedInFinancingActivities/i, /재무활동.*현금흐름/]),
			};
			if (!Object.values(row).some((value) => typeof value === "number" && Number.isFinite(value))) continue;
			if (report.code === "11011") annual.push(row); else quarterly.push(row);
		}
	}
	annual.sort((a, b) => String(b.period).localeCompare(String(a.period)));
	quarterly.sort((a, b) => String(b.period).localeCompare(String(a.period)));
	const latest = annual[0] ?? quarterly[0];
	return {
		annual: annual.slice(0, 5), yearly: annual.slice(0, 5),
		quarterly: quarterly.slice(0, 8), quarters: quarterly.slice(0, 8),
		ratios: { debtRatio: latest?.liabilities != null && latest?.equity ? (latest.liabilities / latest.equity) * 100 : null },
		source: "OPEN_DART", updatedAt: new Date().toISOString(),
	};
}

function secFactUnits(data: any, tags: string[]) {
	for (const tag of tags) {
		const units = data?.facts?.["us-gaap"]?.[tag]?.units;
		if (!units || typeof units !== "object") continue;
		const first = Object.values(units).find((value) => Array.isArray(value));
		if (Array.isArray(first)) return first as any[];
	}
	return [];
}

function secFactValueFor(data: any, tags: string[], end: string, form: string) {
	for (const tag of tags) {
		const matches = secFactUnits(data, [tag]).filter((item) => String(item?.end ?? "") === end && String(item?.form ?? "") === form).sort((a, b) => String(b?.filed ?? "").localeCompare(String(a?.filed ?? "")));
		const value = financialNumber(matches[0]?.val);
		if (value != null) return value;
	}
	return null;
}

async function fetchSecFinancials(ticker: string) {
	const cik = await getSecCik(ticker);
	if (!cik) return { annual: [], quarterly: [], ratios: {}, source: "SEC_COMPANYFACTS", updatedAt: new Date().toISOString() };
	const response = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: secHeaders() });
	if (!response.ok) throw new Error("SEC_COMPANYFACTS_HTTP_" + response.status);
	const data: any = await response.json();
	const revenueTags = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"];
	const seed = secFactUnits(data, revenueTags).filter((item) => ["10-K", "10-Q"].includes(String(item?.form ?? "")) && item?.end);
	const periods = [...new Map(seed.map((item) => [`${item.form}:${item.end}`, { end: String(item.end), form: String(item.form), fy: Number(item.fy), fp: String(item.fp ?? "") }])).values()]
		.filter((item: any) => Date.parse(item.end) <= Date.now())
		.sort((a: any, b: any) => b.end.localeCompare(a.end));
	const tags = {
		revenue: revenueTags,
		operatingIncome: ["OperatingIncomeLoss"],
		netIncome: ["NetIncomeLoss", "ProfitLoss"],
		assets: ["Assets"], liabilities: ["Liabilities"],
		equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
		capitalStock: ["CommonStocksIncludingAdditionalPaidInCapital", "CommonStockValue", "AdditionalPaidInCapital"],
		cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
		operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
		investingCashFlow: ["NetCashProvidedByUsedInInvestingActivities"],
		financingCashFlow: ["NetCashProvidedByUsedInFinancingActivities"],
	};
	const build = (period: any) => ({
		period: period.end.slice(0, 7).replace("-", "."), periodLabel: `${period.fy || period.end.slice(0,4)} ${period.fp || (period.form === "10-K" ? "연간" : "분기")}`,
		revenue: secFactValueFor(data, tags.revenue, period.end, period.form),
		operatingIncome: secFactValueFor(data, tags.operatingIncome, period.end, period.form),
		netIncome: secFactValueFor(data, tags.netIncome, period.end, period.form),
		assets: secFactValueFor(data, tags.assets, period.end, period.form),
		liabilities: secFactValueFor(data, tags.liabilities, period.end, period.form),
		equity: secFactValueFor(data, tags.equity, period.end, period.form),
		capitalStock: secFactValueFor(data, tags.capitalStock, period.end, period.form),
		cash: secFactValueFor(data, tags.cash, period.end, period.form),
		operatingCashFlow: secFactValueFor(data, tags.operatingCashFlow, period.end, period.form),
		investingCashFlow: secFactValueFor(data, tags.investingCashFlow, period.end, period.form),
		financingCashFlow: secFactValueFor(data, tags.financingCashFlow, period.end, period.form),
	});
	const annual = periods.filter((item: any) => item.form === "10-K").slice(0, 5).map(build);
	const quarterly = periods.filter((item: any) => item.form === "10-Q").slice(0, 8).map(build);
	const latest = annual[0] ?? quarterly[0];
	return { annual, yearly: annual, quarterly, quarters: quarterly, ratios: { debtRatio: latest?.liabilities != null && latest?.equity ? (latest.liabilities / latest.equity) * 100 : null }, source: "SEC_COMPANYFACTS", updatedAt: new Date().toISOString() };
}

async function fetchFinancials(ticker: string) {
	if (/^\d{6}$/.test(ticker)) {
		const [raw, naver] = await Promise.all([
			getDartProviderFinancials(ticker),
			fetchNaverFinancials(ticker).catch(() => null),
		]);
		const equity = Number(raw.latest?.equity ?? 0);
		const netIncome = Number(raw.latest?.netIncome ?? 0);
		const liabilities = Number(raw.latest?.liabilities ?? 0);
		const latestAnnual = Array.isArray(raw.annual) ? raw.annual.at(-1) : null;
		const latestRevenue = Number(latestAnnual?.revenue ?? 0);
		const marketCap = Number(naver?.marketCap ?? 0);
		const naverRatios = naver?.ratios ?? {};
		return {
			...raw,
			yearly: raw.annual,
			quarters: raw.quarterly,
			ratios: {
				roe: financialNumber(naverRatios.roe) ?? (equity ? (netIncome / equity) * 100 : null),
				debtRatio: equity ? (liabilities / equity) * 100 : null,
				per: financialNumber(naverRatios.per),
				pbr: financialNumber(naverRatios.pbr),
				psr: marketCap > 0 && latestRevenue > 0 ? marketCap / latestRevenue : null,
			},
			marketCap: marketCap || null,
			source: "OPEN_DART",
			updatedAt: new Date().toISOString(),
		};
	}
	return fetchSecFinancials(ticker);
}

function simpleDartSummary(item: any) {
	const title = String(item?.title ?? item?.report_nm ?? "").trim();
	if (
		!title ||
		title.includes("공시 전체보기") ||
		title.includes("공식 전자공시 검색")
	) {
		return "DART에서 이 종목의 전체 공시 원문을 확인할 수 있습니다.";
	}
	if (/주주총회|주총/.test(title))
		return "주주총회 개최 또는 관련 일정이 공시되었습니다.";
	if (/현금.*배당|배당.*결정|배당금/.test(title))
		return "주주 배당과 관련된 내용이 공시되었습니다.";
	if (/유상증자/.test(title))
		return "유상증자 계획 또는 진행 내용이 공시되었습니다.";
	if (/무상증자/.test(title))
		return "무상증자 계획 또는 진행 내용이 공시되었습니다.";
	if (/자기주식|자사주/.test(title))
		return "자사주 취득·처분과 관련된 내용이 공시되었습니다.";
	if (/단일판매|공급계약|수주/.test(title))
		return "신규 계약 또는 수주 관련 내용이 공시되었습니다.";
	if (/잠정.*실적|영업.*실적|매출액.*손익/.test(title))
		return "최근 경영실적과 관련된 내용이 공시되었습니다.";
	if (/사업보고서/.test(title))
		return "사업보고서가 제출되어 회사의 주요 실적과 현황을 확인할 수 있습니다.";
	if (/분기보고서/.test(title))
		return "분기보고서가 제출되어 최근 분기 실적을 확인할 수 있습니다.";
	if (/반기보고서/.test(title))
		return "반기보고서가 제출되어 상반기 실적을 확인할 수 있습니다.";
	if (/최대주주/.test(title))
		return "최대주주 또는 주요 지분 변동 내용이 공시되었습니다.";
	const shortTitle = title.length > 58 ? title.slice(0, 58) + "…" : title;
	return shortTitle + " 관련 공시가 등록되었습니다.";
}

function simpleNewsSummary(item: any) {
	const source = String(item?.source ?? "").trim();
	let title = String(item?.title ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const suffix = source ? " - " + source : "";
	if (suffix && title.endsWith(suffix))
		title = title.slice(0, -suffix.length).trim();
	const shortTitle = title.length > 70 ? title.slice(0, 70) + "…" : title;
	return shortTitle
		? shortTitle + " 관련 소식입니다."
		: "최근 관련 뉴스를 확인했습니다.";
}

async function fetchGoogleNews(ticker: string, allHistory = false) {
	let profile: any = null;
	try {
		profile = await MarketDataService.getCompanyProfile(ticker);
	} catch {
		profile = null;
	}
	const companyName = companyNameFromProfile(profile, ticker);
	const isKorean = /^\d{6}$/.test(ticker);
	const query = isKorean
		? '"' + companyName + '" 주식'
		: '"' + companyName + '" stock';
	const feedUrl =
		"https://news.google.com/rss/search?q=" +
		encodeURIComponent(query) +
		"&hl=" +
		(isKorean ? "ko" : "en-US") +
		"&gl=" +
		(isKorean ? "KR" : "US") +
		"&ceid=" +
		(isKorean ? "KR:ko" : "US:en");
	const response = await fetch(feedUrl, {
		headers: { "User-Agent": "seungjae-stock-app/1.0" },
	});
	if (!response.ok) throw new Error("NEWS_RSS_HTTP_" + response.status);
	const xml = await response.text();

	const normalized = (title: string, source: string) => {
		const suffix = source ? " - " + source.toLowerCase() : "";
		let value = title.toLowerCase().replace(/\s+/g, " ").trim();
		if (suffix && value.endsWith(suffix)) value = value.slice(0, -suffix.length);
		return value
			.replace(/\[[^\]]+\]|\([^)]*\)/g, " ")
			.replace(/[^0-9a-z가-힣]+/g, "")
			.slice(0, 80);
	};
	const grouped = new Map<string, any>();
	const items = (xml.match(/<item>[\s\S]*?<\/item>/g) ?? [])
		.slice(0, 100)
		.map((block) => ({
			title: xmlTag(block, "title"),
			url: xmlTag(block, "link"),
			link: xmlTag(block, "link"),
			publishedAt: xmlTag(block, "pubDate"),
			date: xmlTag(block, "pubDate"),
			source: xmlTag(block, "source") || "Google News",
			description: cleanFinanceCell(xmlTag(block, "description")),
			summary: cleanFinanceCell(xmlTag(block, "description")),
		}))
		.filter((item) => {
			const timestamp = Date.parse(item.publishedAt);
			return item.title && item.url && Number.isFinite(timestamp);
		})
		.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

	for (const item of items) {
		const key = normalized(item.title, item.source) || item.url;
		const existing = grouped.get(key);
		if (existing) existing.relatedCount = Number(existing.relatedCount ?? 1) + 1;
		else grouped.set(key, { ...item, relatedCount: 1 });
	}

	const groupedItems = [...grouped.values()];
	return allHistory ? groupedItems : groupedItems.slice(0, 5);
}

const autoTradeExecuted = new Set<string>();
interface AutoTradePosition {
	memberId: string;
	ticker: string;
	name: string;
	market: "KR" | "US";
	currency: "KRW" | "USD";
	exchange: KiwoomUsExchange | null;
	quantity: number;
	entryPrice: number;
	stopPrice: number;
	targetPrice: number;
	probability: number;
	reasons: string[];
	journalId: string;
	openedAt: string;
	exitSignalReason?: string | null;
	exitSignalAt?: string | null;
}
interface AutoTradeJournalEntry {
	memberId: string;
	id: string;
	ticker: string;
	name: string;
	market: "KR" | "US";
	currency: "KRW" | "USD";
	exchange: KiwoomUsExchange | null;
	status: "OPEN" | "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL_CLOSE";
	quantity: number;
	entryPrice: number;
	exitPrice: number | null;
	stopPrice: number;
	targetPrice: number;
	probability: number;
	entryReasons: string[];
	entryAnalysis: string;
	exitReason: string | null;
	exitAnalysis: string | null;
	profitPercent: number | null;
	entryOrderNo: string | null;
	exitOrderNo: string | null;
	openedAt: string;
	closedAt: string | null;
}
const autoTradePositions = new Map<string, AutoTradePosition>();
let autoTradeJournal: AutoTradeJournalEntry[] = [];
const autoTradePositionFile = path.resolve(
	process.env.KIWOOM_AUTO_TRADE_POSITION_FILE?.trim() ||
		"data/auto-trade-positions.json",
);
const autoTradeJournalFile = path.resolve(
	process.env.KIWOOM_AUTO_TRADE_JOURNAL_FILE?.trim() ||
		"data/auto-trade-journal.json",
);
let autoTradePositionsLoaded = false;

function autoTradePositionKey(memberId: string, market: "KR" | "US", ticker: string) {
	return `${memberId}:${market}:${ticker}`;
}

async function ensureAutoTradePositionsLoaded() {
	if (autoTradePositionsLoaded) return;
	autoTradePositionsLoaded = true;

	try {
		const parsed = JSON.parse(await readFile(autoTradePositionFile, "utf8"));
		if (!Array.isArray(parsed)) return;
		for (const raw of parsed) {
			const position = raw as Partial<AutoTradePosition>;
			const memberId = String(position.memberId ?? "").trim();
			// 과거 전역 기록은 특정 회원에게 임의 배정하지 않고 격리합니다.
			if (!memberId) continue;
			const ticker = normalizeTicker(position.ticker);
			const market: "KR" | "US" = position.market === "US" ? "US" : "KR";
			const currency: "KRW" | "USD" = market === "US" ? "USD" : "KRW";
			const exchange = market === "US" && ["NASDAQ", "NYSE", "AMEX"].includes(String(position.exchange))
				? position.exchange as KiwoomUsExchange
				: null;
			const quantity = Math.trunc(Number(position.quantity));
			const entryPrice = Number(position.entryPrice);
			const stopPrice = Number(position.stopPrice);
			const targetPrice = Number(position.targetPrice);
			if (
				(market === "KR" ? /^\d{6}$/.test(ticker) : /^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) &&
				(market === "KR" || exchange !== null) &&
				quantity > 0 &&
				entryPrice > 0 &&
				stopPrice > 0 &&
				targetPrice > 0
			) {
				autoTradePositions.set(autoTradePositionKey(memberId, market, ticker), {
					memberId,
					ticker,
					name: String(position.name ?? ticker),
					market,
					currency,
					exchange,
					quantity,
					entryPrice,
					stopPrice,
					targetPrice,
					probability: Number(position.probability ?? 0),
					reasons: Array.isArray(position.reasons) ? position.reasons.map(String) : [],
					journalId: String(position.journalId ?? `${position.openedAt ?? "legacy"}:${ticker}`),
					openedAt: String(position.openedAt ?? new Date().toISOString()),
					exitSignalReason: position.exitSignalReason ? String(position.exitSignalReason) : null,
					exitSignalAt: position.exitSignalAt ? String(position.exitSignalAt) : null,
				});
			}
		}
	} catch {
		// 첫 실행이거나 저장 파일이 없으면 빈 상태로 시작합니다.
	}
	try {
		const parsed = JSON.parse(await readFile(autoTradeJournalFile, "utf8"));
		autoTradeJournal = Array.isArray(parsed)
			? parsed.slice(-500).flatMap((raw) => {
				const entry = raw as Partial<AutoTradeJournalEntry>;
				const memberId = String(entry.memberId ?? "").trim();
				if (!memberId) return [];
				const market: "KR" | "US" = entry.market === "US" ? "US" : "KR";
				return [{
					...entry,
					memberId,
					market,
					currency: market === "US" ? "USD" : "KRW",
					exchange: market === "US" && ["NASDAQ", "NYSE", "AMEX"].includes(String(entry.exchange))
						? entry.exchange as KiwoomUsExchange
						: null,
				}] as AutoTradeJournalEntry[];
			})
			: [];
	} catch {
		autoTradeJournal = [];
	}
}

async function saveAutoTradePositions() {
	await mkdir(path.dirname(autoTradePositionFile), { recursive: true });
	await writeFile(
		autoTradePositionFile,
		JSON.stringify([...autoTradePositions.values()], null, 2),
		"utf8",
	);
}

async function saveAutoTradeJournal() {
	await mkdir(path.dirname(autoTradeJournalFile), { recursive: true });
	await writeFile(
		autoTradeJournalFile,
		JSON.stringify(autoTradeJournal.slice(-500), null, 2),
		"utf8",
	);
}

function marketTimeParts(timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date());
	return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function marketOpenNow(market: "KR" | "US") {
	if (process.env.KIWOOM_AUTO_TRADE_ALLOW_OFF_HOURS === "true") return true;
	const parts = marketTimeParts(market === "US" ? "America/New_York" : "Asia/Seoul");
	if (["Sat", "Sun"].includes(parts.weekday)) return false;
	const minutes = Number(parts.hour) * 60 + Number(parts.minute);
	return market === "US"
		? minutes >= 9 * 60 + 30 && minutes < 16 * 60
		: minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

function marketDateString(market: "KR" | "US", value: Date | string = new Date()) {
	const date = value instanceof Date ? value : new Date(value);
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: market === "US" ? "America/New_York" : "Asia/Seoul",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

function normalizeUsExchange(value: unknown, ticker: string): KiwoomUsExchange | null {
	const normalized = String(value ?? "").trim().toUpperCase();
	if (normalized === "NASDAQ" || normalized === "NASD" || normalized === "ND") return "NASDAQ";
	if (normalized === "NYSE" || normalized === "NY") return "NYSE";
	if (normalized === "AMEX" || normalized === "NYSE AMERICAN" || normalized === "NA") return "AMEX";
	if (["AAPL", "MSFT", "NVDA", "AMZN", "META", "TSLA"].includes(ticker)) return "NASDAQ";
	return null;
}

function formatTradePrice(value: number, currency: "KRW" | "USD") {
	return new Intl.NumberFormat(currency === "USD" ? "en-US" : "ko-KR", {
		style: "currency",
		currency,
		maximumFractionDigits: currency === "USD" ? 2 : 0,
	}).format(value);
}

interface AutoTradeApprovalPlan {
	token: string;
	memberId: string;
	expiresAt: number;
	body: {
		candidates: any[];
		investmentPerTrade: number;
		stopLossPercent: number;
		takeProfitPercent: number;
	};
	order: {
		ticker: string; name: string; market: "KR" | "US"; currency: "KRW" | "USD";
		quantity: number; currentPrice: number; estimatedAmount: number; stopPrice: number; targetPrice: number;
	};
}
const autoTradeApprovalPlans = new Map<string, AutoTradeApprovalPlan>();

interface AutoTradeCloseApprovalPlan {
	token: string;
	memberId: string;
	expiresAt: number;
	positionKey: string;
	order: {
		ticker: string; name: string; market: "KR" | "US"; currency: "KRW" | "USD";
		quantity: number; currentPrice: number; estimatedAmount: number; stopPrice: number; targetPrice: number; reason: string;
	};
}
const autoTradeCloseApprovalPlans = new Map<string, AutoTradeCloseApprovalPlan>();

function cleanupAutoTradeApprovalPlans() {
	const now = Date.now();
	for (const [token, plan] of autoTradeApprovalPlans) {
		if (plan.expiresAt <= now) autoTradeApprovalPlans.delete(token);
	}
	for (const [token, plan] of autoTradeCloseApprovalPlans) {
		if (plan.expiresAt <= now) autoTradeCloseApprovalPlans.delete(token);
	}
}

function validateRealOrderAccess(req: AuthenticatedRequest): { ok: true } | { ok: false; status: number; message: string } {
	const enabled = process.env.KIWOOM_AUTO_TRADE_ENABLED === "true";
	const realMode = String(process.env.KIWOOM_MODE ?? "").trim().toLowerCase() === "real";
	const configuredKey = String(process.env.KIWOOM_AUTO_TRADE_KEY ?? "").trim();
	const suppliedKey = String(req.header("X-Auto-Trade-Key") ?? "").trim();
	if (!enabled) return { ok: false, status: 403, message: "서버의 실제 자동매매 기능이 꺼져 있습니다." };
	if (!realMode) return { ok: false, status: 409, message: "실제 주문은 KIWOOM_MODE=real 설정이 필요합니다." };
	if (!configuredKey || suppliedKey !== configuredKey) return { ok: false, status: 401, message: "자동매매 실행키가 올바르지 않습니다." };
	if (!req.member?.id) return { ok: false, status: 401, message: "로그인이 필요합니다." };
	return { ok: true };
}

// POST /api/stocks/auto-trade/plan — 실제 주문은 하지 않고 10분짜리 일회성 승인계획만 만듭니다.
router.post("/auto-trade/plan", async (req: AuthenticatedRequest, res) => {
	const enabled = process.env.KIWOOM_AUTO_TRADE_ENABLED === "true";
	const realMode = String(process.env.KIWOOM_MODE ?? "").trim().toLowerCase() === "real";
	const configuredKey = String(process.env.KIWOOM_AUTO_TRADE_KEY ?? "").trim();
	const suppliedKey = String(req.header("X-Auto-Trade-Key") ?? "").trim();
	if (!enabled) return res.status(403).json({ ok: false, message: "서버의 실제 자동매매 기능이 꺼져 있습니다." });
	if (!realMode) return res.status(409).json({ ok: false, message: "실제 주문계획은 KIWOOM_MODE=real 설정이 필요합니다." });
	if (!configuredKey || suppliedKey !== configuredKey) return res.status(401).json({ ok: false, message: "자동매매 실행키가 올바르지 않습니다." });
	if (!req.member?.id) return res.status(401).json({ ok: false, message: "로그인이 필요합니다." });

	const candidates = Array.isArray(req.body?.candidates)
		? [...req.body.candidates].sort((a, b) => Number(b?.probability ?? b?.score ?? 0) - Number(a?.probability ?? a?.score ?? 0)).slice(0, 1)
		: [];
	const candidate = candidates[0];
	if (!candidate) return res.status(400).json({ ok: false, message: "승인할 주문 후보가 없습니다." });
	const ticker = normalizeTicker(candidate.ticker);
	const market: "KR" | "US" = candidate.market === "US" ? "US" : "KR";
	const currency: "KRW" | "USD" = market === "US" ? "USD" : "KRW";
	const investmentPerTrade = Math.max(1, Math.min(1_000_000, Math.round(Number(req.body?.investmentPerTrade ?? 0))));
	const stopLossPercent = Math.min(20, Math.max(0.1, Number(req.body?.stopLossPercent ?? 3)));
	const takeProfitPercent = Math.min(100, Math.max(0.1, Number(req.body?.takeProfitPercent ?? 5)));
	const quote = await MarketDataService.getQuoteRow(ticker);
	const currentPrice = Math.abs(Number(quote?.price ?? 0));
	if (!Number.isFinite(currentPrice) || currentPrice <= 0) return res.status(409).json({ ok: false, message: "주문계획 생성 전 현재가를 확인하지 못했습니다." });
	const quantity = Math.floor(investmentPerTrade / currentPrice);
	if (quantity < 1) return res.status(409).json({ ok: false, message: "설정 주문금액으로 1주 이상 주문할 수 없습니다." });
	const stopPrice = currentPrice * (1 - stopLossPercent / 100);
	const targetPrice = currentPrice * (1 + takeProfitPercent / 100);
	cleanupAutoTradeApprovalPlans();
	const token = randomUUID();
	const expiresAt = Date.now() + 10 * 60_000;
	const plan: AutoTradeApprovalPlan = {
		token, memberId: req.member.id, expiresAt,
		body: { candidates, investmentPerTrade, stopLossPercent, takeProfitPercent },
		order: { ticker, name: String(candidate.name ?? ticker), market, currency, quantity, currentPrice, estimatedAmount: quantity * currentPrice, stopPrice, targetPrice },
	};
	autoTradeApprovalPlans.set(token, plan);
	return res.json({ ok: true, approvalToken: token, expiresAt: new Date(expiresAt).toISOString(), order: plan.order, message: "주문 내용을 확인한 뒤 10분 안에 한 번만 승인할 수 있습니다." });
});

// POST /api/stocks/auto-trade/close-plan — 보유 전량 매도 계획만 생성하고 주문하지 않습니다.
router.post("/auto-trade/close-plan", async (req: AuthenticatedRequest, res) => {
	const access = validateRealOrderAccess(req);
	if (!access.ok) return res.status(access.status).json({ ok: false, message: access.message });
	await ensureAutoTradePositionsLoaded();
	const memberId = req.member!.id;
	const ticker = normalizeTicker(req.body?.ticker);
	const market: "KR" | "US" = req.body?.market === "US" ? "US" : "KR";
	const positionKey = autoTradePositionKey(memberId, market, ticker);
	const position = autoTradePositions.get(positionKey);
	if (!position) return res.status(404).json({ ok: false, message: "현재 회원의 보유 자동매매 포지션을 찾지 못했습니다." });
	if (!marketOpenNow(market)) return res.status(409).json({ ok: false, message: market === "US" ? "미국 정규장 주문 가능 시간이 아닙니다." : "국내 정규장 주문 가능 시간이 아닙니다." });
	const quote = await MarketDataService.getQuoteRow(ticker);
	const currentPrice = Math.abs(Number(quote?.price ?? 0));
	if (!Number.isFinite(currentPrice) || currentPrice <= 0) return res.status(409).json({ ok: false, message: "매도계획 생성 전 현재가를 확인하지 못했습니다." });
	const reason = currentPrice <= position.stopPrice
		? "손절가 도달"
		: currentPrice >= position.targetPrice
			? "목표가 도달"
			: "사용자 수동 청산";
	cleanupAutoTradeApprovalPlans();
	const token = randomUUID();
	const expiresAt = Date.now() + 10 * 60_000;
	const plan: AutoTradeCloseApprovalPlan = {
		token,
		memberId,
		expiresAt,
		positionKey,
		order: {
			ticker: position.ticker,
			name: position.name,
			market: position.market,
			currency: position.currency,
			quantity: position.quantity,
			currentPrice,
			estimatedAmount: currentPrice * position.quantity,
			stopPrice: position.stopPrice,
			targetPrice: position.targetPrice,
			reason,
		},
	};
	autoTradeCloseApprovalPlans.set(token, plan);
	return res.json({
		ok: true,
		approvalToken: token,
		expiresAt: new Date(expiresAt).toISOString(),
		order: plan.order,
		message: "매도 내용을 확인한 뒤 10분 안에 한 번만 승인할 수 있습니다.",
	});
});

// POST /api/stocks/auto-trade/close-execute — 일회성 승인 토큰이 있을 때만 전량 매도합니다.
router.post("/auto-trade/close-execute", async (req: AuthenticatedRequest, res) => {
	cleanupAutoTradeApprovalPlans();
	const approvalToken = String(req.body?.approvalToken ?? "").trim();
	const approval = autoTradeCloseApprovalPlans.get(approvalToken);
	if (!approval || approval.expiresAt <= Date.now() || approval.memberId !== req.member?.id) {
		return res.status(409).json({ ok: false, message: "매도 승인이 없거나 만료되었습니다. 매도계획을 다시 확인해 주세요." });
	}
	// 같은 토큰의 중복 주문을 막기 위해 주문 검사 시작 전에 폐기합니다.
	autoTradeCloseApprovalPlans.delete(approvalToken);
	const access = validateRealOrderAccess(req);
	if (!access.ok) return res.status(access.status).json({ ok: false, message: access.message });
	await ensureAutoTradePositionsLoaded();
	const position = autoTradePositions.get(approval.positionKey);
	if (!position || position.memberId !== req.member!.id) {
		return res.status(404).json({ ok: false, message: "청산할 현재 회원의 포지션이 없습니다." });
	}
	if (!marketOpenNow(position.market)) {
		return res.status(409).json({ ok: false, message: position.market === "US" ? "미국 정규장 주문 가능 시간이 아닙니다." : "국내 정규장 주문 가능 시간이 아닙니다." });
	}
	const quote = await MarketDataService.getQuoteRow(position.ticker);
	const currentPrice = Math.abs(Number(quote?.price ?? 0));
	if (!Number.isFinite(currentPrice) || currentPrice <= 0) return res.status(409).json({ ok: false, message: "매도 직전 현재가를 확인하지 못했습니다." });

	try {
		const order = position.market === "US"
			? await placeKiwoomUsOrder({ ticker: position.ticker, exchange: position.exchange!, side: "sell", quantity: position.quantity, orderType: "market" })
			: await placeKiwoomDomesticOrder({ ticker: position.ticker, side: "sell", quantity: position.quantity, orderType: "market" });
		const closedAt = new Date().toISOString();
		const status: AutoTradeJournalEntry["status"] = currentPrice <= position.stopPrice
			? "STOP_LOSS"
			: currentPrice >= position.targetPrice
				? "TAKE_PROFIT"
				: "MANUAL_CLOSE";
		const reason = status === "STOP_LOSS" ? "손절가 도달" : status === "TAKE_PROFIT" ? "목표가 도달" : "사용자 수동 청산";
		const profitPercent = position.entryPrice > 0 ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100 : 0;
		const journal = autoTradeJournal.find((entry) => entry.memberId === position.memberId && entry.id === position.journalId);
		if (journal) {
			journal.status = status;
			journal.exitPrice = currentPrice;
			journal.exitReason = reason;
			journal.exitAnalysis = `${reason}에 따라 사용자 확인 후 ${position.quantity}주 시장가 매도 주문을 전송했습니다.`;
			journal.profitPercent = profitPercent;
			journal.exitOrderNo = order.orderNo ?? null;
			journal.closedAt = closedAt;
		}
		autoTradePositions.delete(approval.positionKey);
		await saveAutoTradePositions();
		await saveAutoTradeJournal();
		void deliverMemberNotification({
			memberId: position.memberId,
			type: "auto_trade",
			title: `매도 주문 전송 · ${position.name}`,
			body: `${reason} · ${position.quantity}주 · 기준가 ${formatTradePrice(currentPrice, position.currency)} · 예상 수익률 ${profitPercent >= 0 ? "+" : ""}${profitPercent.toFixed(2)}%`,
			url: "/auto-trading",
			app: true,
			push: true,
			metadata: { ticker: position.ticker, market: position.market, quantity: position.quantity, currentPrice, reason, orderNo: order.orderNo ?? null },
		}).catch((error) => console.error("auto trade close notification error:", error));
		return res.json({ ok: true, ticker: position.ticker, market: position.market, quantity: position.quantity, orderNo: order.orderNo ?? null, currentPrice, reason, profitPercent, message: "사용자 승인에 따라 시장가 매도 주문을 전송했습니다." });
	} catch (error) {
		const message = error instanceof Error ? error.message : "키움 매도 주문 전송 실패";
		void deliverMemberNotification({ memberId: position.memberId, type: "auto_trade", title: `매도 주문 실패 · ${position.name}`, body: message, url: "/auto-trading", app: true, push: true }).catch(() => undefined);
		return res.status(502).json({ ok: false, message });
	}
});

// POST /api/stocks/auto-trade/execute
router.post("/auto-trade/execute", async (req: AuthenticatedRequest, res) => {
	cleanupAutoTradeApprovalPlans();
	const approvalToken = String(req.body?.approvalToken ?? "").trim();
	const approval = autoTradeApprovalPlans.get(approvalToken);
	if (!approval || approval.expiresAt <= Date.now() || approval.memberId !== req.member?.id) {
		return res.status(409).json({ ok: false, message: "주문 승인이 없거나 만료되었습니다. 주문계획을 다시 확인해 주세요." });
	}
	// 재사용을 막기 위해 주문 검사를 시작하기 전에 일회성 토큰을 폐기합니다.
	autoTradeApprovalPlans.delete(approvalToken);
	const approvedBody = approval.body;
	const enabled = process.env.KIWOOM_AUTO_TRADE_ENABLED === "true";
	const realMode = String(process.env.KIWOOM_MODE ?? "").trim().toLowerCase() === "real";
	const configuredKey = String(process.env.KIWOOM_AUTO_TRADE_KEY ?? "").trim();
	const suppliedKey = String(req.header("X-Auto-Trade-Key") ?? "").trim();

	if (!enabled) {
		return res.status(403).json({ ok: false, message: "서버의 실제 자동매매 기능이 꺼져 있습니다." });
	}
	if (!realMode) {
		return res.status(409).json({
			ok: false,
			message: "실제 자동매매는 서버의 KIWOOM_MODE=real 설정과 실전용 App Key가 필요합니다.",
		});
	}
	if (!configuredKey || suppliedKey !== configuredKey) {
		return res.status(401).json({ ok: false, message: "자동매매 실행키가 올바르지 않습니다." });
	}

	await ensureAutoTradePositionsLoaded();
	const memberId = req.member!.id;

	// 클라이언트 순서를 신뢰하지 않고 서버에서 모델점수를 다시 비교해
	// 가장 높은 한 종목만 주문 대상으로 사용합니다.
	const candidates = Array.isArray(approvedBody.candidates)
		? [...approvedBody.candidates]
			.sort((a, b) => Number(b?.probability ?? 0) - Number(a?.probability ?? 0))
			.slice(0, 1)
		: [];
	const investmentPerTrade = Math.max(1, Number(approvedBody.investmentPerTrade ?? 0));
	const stopLossPercent = Math.min(20, Math.max(0.1, Number(approvedBody.stopLossPercent ?? 3)));
	const takeProfitPercent = Math.min(100, Math.max(0.1, Number(approvedBody.takeProfitPercent ?? 5)));
	const minimumProbability = Math.min(
		99,
		Math.max(1, Number(process.env.KIWOOM_AUTO_TRADE_MIN_PROBABILITY ?? 70)),
	);
	const maximumRiskScore = Math.min(
		100,
		Math.max(0, Number(process.env.KIWOOM_AUTO_TRADE_MAX_RISK_SCORE ?? 55)),
	);
	const minimumDataCompleteness = Math.min(
		100,
		Math.max(0, Number(process.env.KIWOOM_AUTO_TRADE_MIN_DATA_COMPLETENESS ?? 45)),
	);
	const dailyOrderLimit = Math.max(
		1,
		Number(process.env.KIWOOM_AUTO_TRADE_DAILY_ORDER_LIMIT ?? 1),
	);
	const results: any[] = [];

	for (const candidate of candidates) {
		const ticker = normalizeTicker(candidate?.ticker);
		const market: "KR" | "US" = candidate?.market === "US" ? "US" : "KR";
		const currency: "KRW" | "USD" = market === "US" ? "USD" : "KRW";
		const exchange = market === "US"
			? normalizeUsExchange(candidate?.exchange, ticker)
			: null;
		const probability = Number(candidate?.probability ?? 0);
		const riskScore = Number(candidate?.riskScore ?? 50);
		const dataCompleteness = Number(candidate?.dataCompleteness ?? 50);
		const day = marketDateString(market);
		const key = `${memberId}:${day}:${market}:${ticker}:BUY`;
		const positionKey = autoTradePositionKey(memberId, market, ticker);
		const ordersPlacedToday = autoTradeJournal.filter(
			(entry) => entry.memberId === memberId && entry.market === market && marketDateString(market, entry.openedAt) === day,
		).length;

		if (ordersPlacedToday >= dailyOrderLimit) {
			results.push({
				ticker,
				ok: true,
				skipped: true,
				message: `오늘 자동매매 신규 주문 한도(${dailyOrderLimit}회)에 도달했습니다.`,
			});
			continue;
		}

		if (market === "KR" && !/^\d{6}$/.test(ticker)) {
			results.push({ ticker, market, ok: false, skipped: true, message: "국내 종목코드 형식이 올바르지 않습니다." });
			continue;
		}
		if (market === "US" && (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker) || !exchange)) {
			results.push({ ticker, market, ok: false, skipped: true, message: "미국 종목코드 또는 거래소(NASDAQ/NYSE/AMEX)를 확인할 수 없습니다." });
			continue;
		}
		if (!marketOpenNow(market)) {
			results.push({
				ticker,
				market,
				ok: false,
				skipped: true,
				message: market === "US" ? "미국 정규장 주문 가능 시간이 아닙니다." : "국내 정규장 주문 가능 시간이 아닙니다.",
			});
			continue;
		}
		if (!Number.isFinite(probability) || probability < minimumProbability) {
			results.push({
				ticker,
				ok: false,
				skipped: true,
				message: `서버 최소 확률 ${minimumProbability}%를 충족하지 못했습니다.`,
			});
			continue;
		}
		if (!Number.isFinite(riskScore) || riskScore > maximumRiskScore) {
			results.push({
				ticker,
				market,
				ok: false,
				skipped: true,
				message: `위험점수 ${Math.round(riskScore)}점으로 서버 허용치 ${maximumRiskScore}점을 초과했습니다.`,
			});
			continue;
		}
		if (!Number.isFinite(dataCompleteness) || dataCompleteness < minimumDataCompleteness) {
			results.push({
				ticker,
				market,
				ok: false,
				skipped: true,
				message: `데이터 충족도 ${Math.round(dataCompleteness)}%로 서버 최소치 ${minimumDataCompleteness}%보다 낮습니다.`,
			});
			continue;
		}
		if (autoTradePositions.has(positionKey)) {
			results.push({ ticker, ok: true, skipped: true, message: "이미 자동매매로 보유 중인 종목입니다." });
			continue;
		}
		if (autoTradeExecuted.has(key)) {
			results.push({ ticker, ok: true, skipped: true, message: "오늘 이미 주문한 종목입니다." });
			continue;
		}

		let price = 0;
		try {
			const quote: any = await MarketDataService.getQuoteRow(ticker);
			price = Math.abs(Number(quote?.price ?? quote?.currentPrice ?? quote?.cur_prc ?? 0));
		} catch {
			price = 0;
		}
		if (!Number.isFinite(price) || price <= 0) {
			results.push({ ticker, ok: false, skipped: true, message: "주문 직전 현재가를 확인하지 못했습니다." });
			continue;
		}

		const quantity = Math.floor(investmentPerTrade / price);
		if (quantity < 1) {
			results.push({ ticker, ok: false, skipped: true, message: "주문금액이 현재가보다 작습니다." });
			continue;
		}

		try {
			const order = market === "US"
				? await placeKiwoomUsOrder({
					ticker,
					exchange: exchange!,
					side: "buy",
					quantity,
					orderType: "market",
				})
				: await placeKiwoomDomesticOrder({
					ticker,
					side: "buy",
					quantity,
					orderType: "market",
				});
			const stopPrice = price * (1 - stopLossPercent / 100);
			const targetPrice = price * (1 + takeProfitPercent / 100);
			const openedAt = new Date().toISOString();
			const reasons = Array.isArray(candidate?.reasons)
				? candidate.reasons.map(String).filter(Boolean).slice(0, 8)
				: [];
			const journalId = `${openedAt}:${market}:${ticker}`;
			const name = String(candidate?.name ?? ticker);
			autoTradeExecuted.add(key);
			autoTradePositions.set(positionKey, {
				memberId,
				ticker,
				name,
				market,
				currency,
				exchange,
				quantity,
				entryPrice: price,
				stopPrice,
				targetPrice,
				probability,
				reasons,
				journalId,
				openedAt,
				exitSignalReason: null,
				exitSignalAt: null,
			});
			autoTradeJournal.push({
				memberId,
				id: journalId,
				ticker,
				name,
				market,
				currency,
				exchange,
				status: "OPEN",
				quantity,
				entryPrice: price,
				exitPrice: null,
				stopPrice,
				targetPrice,
				probability,
				entryReasons: reasons,
				entryAnalysis: `${reasons.join(" · ") || "종합 조건"}이 확인되어 후보 중 모델점수 ${probability}점으로 선정했습니다. 현재가 ${formatTradePrice(price, currency)}를 진입 기준으로 손절 ${formatTradePrice(stopPrice, currency)}, 목표 ${formatTradePrice(targetPrice, currency)}를 설정했습니다.`,
				exitReason: null,
				exitAnalysis: null,
				profitPercent: null,
				entryOrderNo: order.orderNo ?? null,
				exitOrderNo: null,
				openedAt,
				closedAt: null,
			});
			await saveAutoTradePositions();
			await saveAutoTradeJournal();
			void deliverMemberNotification({
				memberId,
				type: "auto_trade",
				title: `매수 주문 전송 · ${name}`,
				body: `${quantity}주 · 기준가 ${formatTradePrice(price, currency)} · 손절 ${formatTradePrice(stopPrice, currency)} · 목표 ${formatTradePrice(targetPrice, currency)}`,
				url: "/auto-trading",
				app: true,
				push: true,
				metadata: { ticker, market, quantity, price, stopPrice, targetPrice, orderNo: order.orderNo ?? null },
			}).catch((error) => console.error("auto trade entry notification error:", error));
			results.push({
				ticker,
				market,
				currency,
				ok: true,
				quantity,
				orderNo: order.orderNo,
				stopPrice,
				targetPrice,
				message: "시장가 매수 주문을 전송했습니다.",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "키움 주문 전송 실패";
			void deliverMemberNotification({ memberId, type: "auto_trade", title: `매수 주문 실패 · ${String(candidate?.name ?? ticker)}`, body: message, url: "/auto-trading", app: true, push: true }).catch(() => undefined);
			results.push({
				ticker,
				market,
				ok: false,
				quantity,
				message,
			});
		}
	}

	const completed = results.filter((item) => item.ok && !item.skipped).length;
	return res.json({
		ok: completed > 0 || results.every((item) => item.skipped),
		message: completed > 0 ? `${completed}개 종목 실주문을 전송했습니다.` : "신규 실주문이 전송되지 않았습니다.",
		results,
	});
});

async function inspectAutoTradePositions(memberId: string) {
	await ensureAutoTradePositionsLoaded();
	const results: any[] = [];
	const memberPositions = [...autoTradePositions.values()].filter((position) => position.memberId === memberId);
	let changed = false;
	for (const position of memberPositions) {
		try {
			const quote = await MarketDataService.getQuoteRow(position.ticker);
			const currentPrice = Math.abs(Number(quote?.price ?? 0));
			if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
				results.push({ ticker: position.ticker, market: position.market, ok: false, skipped: true, message: "현재가 확인 실패" });
				continue;
			}
			const reason = currentPrice <= position.stopPrice ? "손절가 도달" : currentPrice >= position.targetPrice ? "목표가 도달" : "보유 유지";
			if (reason === "보유 유지") {
				if (position.exitSignalReason) {
					position.exitSignalReason = null;
					position.exitSignalAt = null;
					changed = true;
				}
			} else if (position.exitSignalReason !== reason) {
				position.exitSignalReason = reason;
				position.exitSignalAt = new Date().toISOString();
				changed = true;
				void deliverMemberNotification({
					memberId,
					type: "auto_trade",
					title: `청산 승인 필요 · ${position.name}`,
					body: `${reason} · 현재가 ${formatTradePrice(currentPrice, position.currency)} · 매도 주문은 아직 전송되지 않았습니다.`,
					url: "/auto-trading",
					app: true,
					push: true,
					metadata: { ticker: position.ticker, market: position.market, currentPrice, stopPrice: position.stopPrice, targetPrice: position.targetPrice, reason },
				}).catch((error) => console.error("auto trade exit signal notification error:", error));
			}
			results.push({
				ticker: position.ticker, market: position.market, ok: true, skipped: true, currentPrice,
				stopPrice: position.stopPrice, targetPrice: position.targetPrice,
				approvalRequired: reason !== "보유 유지",
				message: reason === "보유 유지" ? "손절·목표가 미도달" : `${reason}: 매도 주문은 사용자 승인 전까지 전송하지 않습니다.`,
			});
		} catch (error) {
			results.push({ ticker: position.ticker, market: position.market, ok: false, skipped: true, message: error instanceof Error ? error.message : "감시 실패" });
		}
	}
	if (changed) await saveAutoTradePositions();
	return { results, activePositions: memberPositions.length };
}

// POST /api/stocks/auto-trade/monitor — 감시만 수행하며 주문은 절대 전송하지 않습니다.
router.post("/auto-trade/monitor", async (req: AuthenticatedRequest, res) => {
	const configuredKey = String(process.env.KIWOOM_AUTO_TRADE_KEY ?? "").trim();
	const suppliedKey = String(req.header("X-Auto-Trade-Key") ?? "").trim();
	if (!configuredKey || suppliedKey !== configuredKey) return res.status(401).json({ ok: false, message: "자동매매 실행키가 올바르지 않습니다." });
	const monitored = await inspectAutoTradePositions(req.member!.id);
	return res.json({ ok: true, activePositions: monitored.activePositions, message: "보유 종목을 감시했습니다. 청산 주문은 주문별 사용자 승인 전까지 전송하지 않습니다.", results: monitored.results });
});

// GET /api/stocks/auto-trade/status — 키나 비밀번호는 절대 반환하지 않습니다.
router.get("/auto-trade/status", (_req, res) => {
	const mode = String(process.env.KIWOOM_MODE ?? "").trim().toLowerCase();
	return res.json({
		ok: true,
		mode: mode === "real" ? "real" : "mock",
		enabled: process.env.KIWOOM_AUTO_TRADE_ENABLED === "true",
		domesticSupported: true,
		usSupported: true,
		realKeyConfigured: Boolean(
			process.env.KIWOOM_APP_KEY?.trim() && process.env.KIWOOM_APP_SECRET?.trim(),
		),
		executionKeyConfigured: Boolean(process.env.KIWOOM_AUTO_TRADE_KEY?.trim()),
		checks: [
			"정규장 시간",
			"최소 모델점수",
			"위험점수",
			"데이터 충족도",
			"일일 주문한도",
			"중복 보유",
			"주문 직전 현재가",
		],
	});
});

// GET /api/stocks/auto-trade/journal
router.get("/auto-trade/journal", async (req: AuthenticatedRequest, res) => {
	await ensureAutoTradePositionsLoaded();
	return res.json({ ok: true, entries: autoTradeJournal.filter((entry) => entry.memberId === req.member!.id).reverse() });
});

// GET /api/stocks/:ticker/quote
router.get("/:ticker/quote", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);

	if (!ticker) {
		res.status(400).json({
			error: "MISSING_TICKER",
		});
		return;
	}

	try {
		const quote = await MarketDataService.getQuoteRow(ticker);

		if (!quote) {
			res.status(404).json({
				error: "QUOTE_NOT_FOUND",
				ticker,
			});
			return;
		}

		res.json(quote);
	} catch (error) {
		console.error("stock quote route error:", error);

		res.status(500).json({
			error: "STOCK_QUOTE_ROUTE_ERROR",
			ticker,
		});
	}
});

// 알려진 자리표시자(placeholder) 설명은 실제 데이터가 아니므로 비웁니다.
function isPlaceholderDescription(value: unknown): boolean {
	const text = String(value ?? "").trim();
	if (!text) return true;
	return (
		/기업 정보입니다\.?$/.test(text) ||
		/기업 정보를 확인 중입니다\.?$/.test(text)
	);
}

// DART 기업개황 API(company.json)에서 실제 업종/설립일/홈페이지 등을 가져옵니다.
async function fetchDartCompanyOverview(ticker: string) {
	const apiKey = String(process.env.DART_API_KEY ?? "").trim();
	if (!apiKey || !/^\d{6}$/.test(ticker)) return null;
	const corpCode = await getDartCorpCode(ticker, apiKey);
	if (!corpCode) return null;
	const query = new URLSearchParams({ crtfc_key: apiKey, corp_code: corpCode });
	const response = await fetch(
		`https://opendart.fss.or.kr/api/company.json?${query.toString()}`,
	);
	if (!response.ok) return null;
	const data: any = await response.json();
	if (data?.status !== "000") return null;
	const website = String(data?.hm_url ?? "").trim();
	return {
		industry: String(data?.induty_code ?? "").trim() || null,
		industryName: String(data?.induty ?? "").trim() || null,
		sector: String(data?.induty ?? "").trim() || null,
		website:
			website && !/^https?:\/\//i.test(website) ? `https://${website}` : website || null,
		ceo: String(data?.ceo_nm ?? "").trim() || null,
		establishedAt: String(data?.est_dt ?? "").trim() || null,
		address: String(data?.adres ?? "").trim() || null,
		provider: "DART 기업개황",
	};
}

// Yahoo quoteSummary(assetProfile)에서 실제 사업 요약/섹터/산업/홈페이지를 가져옵니다.
async function fetchYahooAssetProfile(ticker: string) {
	if (/^\d{6}$/.test(ticker)) return null;
	const url =
		`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=assetProfile`;
	const response = await fetch(url, {
		headers: { "User-Agent": "seungjae-stock-app/1.0", Accept: "application/json" },
	});
	if (!response.ok) return null;
	const data: any = await response.json();
	const p = data?.quoteSummary?.result?.[0]?.assetProfile;
	if (!p || typeof p !== "object") return null;
	const summary = String(p?.longBusinessSummary ?? "").trim();
	const website = String(p?.website ?? "").trim();
	return {
		description: summary || null,
		sector: String(p?.sector ?? "").trim() || null,
		industry: String(p?.industry ?? "").trim() || null,
		website: website || null,
		provider: "Yahoo Finance",
	};
}

// GET /api/stocks/:ticker/profile
router.get("/:ticker/profile", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);

	if (!ticker) {
		res.status(400).json({
			error: "MISSING_TICKER",
		});
		return;
	}

	try {
		const base = await MarketDataService.getCompanyProfile(ticker);
		res.json(await enrichCompanyProfile(ticker, base));
	} catch (error) {
		console.error("stock profile route error:", error);

		res.status(500).json({
			error: "STOCK_PROFILE_ROUTE_ERROR",
			ticker,
		});
	}
});

// 실제 공급자(DART/Yahoo) 데이터로 회사 개요를 보강합니다. 없는 값은 채우지 않습니다.
async function enrichCompanyProfile(ticker: string, base: any) {
	const profile: any = { ...(base ?? {}) };
	if (isPlaceholderDescription(profile.description)) profile.description = "";

	try {
		if (/^\d{6}$/.test(ticker)) {
			const dart = await fetchDartCompanyOverview(ticker).catch(() => null);
			if (dart) {
				if (!profile.industry && dart.industryName) profile.industry = dart.industryName;
				if (!profile.sector && dart.sector) profile.sector = dart.sector;
				if (!profile.website && dart.website) profile.website = dart.website;
				if (dart.ceo) profile.ceo = dart.ceo;
				if (dart.establishedAt) profile.establishedAt = dart.establishedAt;
				profile.provider = dart.provider;
			}
		} else {
			const yahoo = await fetchYahooAssetProfile(ticker).catch(() => null);
			if (yahoo) {
				if (!profile.description && yahoo.description) profile.description = yahoo.description;
				if (!profile.sector && yahoo.sector) profile.sector = yahoo.sector;
				if (!profile.industry && yahoo.industry) profile.industry = yahoo.industry;
				if (!profile.website && yahoo.website) profile.website = yahoo.website;
				profile.provider = yahoo.provider;
			}
		}
	} catch {
		// 보강 실패 시 기본 프로필을 그대로 반환합니다.
	}

	if (!profile.provider) {
		profile.provider = /^\d{6}$/.test(ticker) ? "DART/네이버" : "SEC/Yahoo";
	}
	return profile;
}

// GET /api/stocks/:ticker/company
router.get("/:ticker/company", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);

	if (!ticker) {
		res.status(400).json({
			error: "MISSING_TICKER",
		});
		return;
	}

	try {
		const base = await MarketDataService.getCompanyProfile(ticker);
		res.json(await enrichCompanyProfile(ticker, base));
	} catch (error) {
		console.error("stock company route error:", error);

		res.status(500).json({
			error: "STOCK_COMPANY_ROUTE_ERROR",
			ticker,
		});
	}
});

// GET /api/stocks/:ticker/chart?tf=1D — 프런트 ChartData 계약(캔들+지표+신호+등급)
router.get("/:ticker/chart", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);
	const timeframe = normalizeTimeframe(req.query.tf ?? req.query.timeframe);

	if (!ticker) {
		res.status(400).json({ error: "MISSING_TICKER" });
		return;
	}

	try {
		const meta = await MarketDataService.getCandlesMeta(ticker, timeframe as any);
		const indicators = computeIndicators(meta.candles);
		let signals: unknown[] = [];
		try {
			const report = await SignalService.getReport(ticker);
			signals = report?.signals ?? [];
		} catch (signalError) {
			console.error("chart signals failed:", signalError);
		}
		const { overall } = computeScores(ticker);

		res.json({
			ok: true,
			ticker,
			timeframe,
			provider: meta.provider,
			fetchedAt: meta.fetchedAt,
			candles: meta.candles,
			indicators,
			signals,
			rating: scoreToRating(overall),
			count: meta.candles.length,
			updatedAt: meta.fetchedAt,
		});
	} catch (error) {
		console.error("stock chart route error:", error);
		res.status(500).json({ ok: false, error: "STOCK_CHART_ROUTE_ERROR", ticker, timeframe });
	}
});

// GET /api/stocks/:ticker/candles?tf=1D
router.get("/:ticker/candles", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);
	const timeframe = normalizeTimeframe(req.query.tf ?? req.query.timeframe);

	if (!ticker) {
		res.status(400).json({
			error: "MISSING_TICKER",
		});
		return;
	}

	try {
		const meta = await MarketDataService.getCandlesMeta(
			ticker,
			timeframe as any,
		);

		res.json({
			ok: true,
			ticker,
			timeframe,
			provider: meta.provider,
			fetchedAt: meta.fetchedAt,
			candles: meta.candles,
			count: meta.candles.length,
			updatedAt: meta.fetchedAt,
		});
	} catch (error) {
		console.error("stock candles route error:", error);

		res.status(500).json({
			ok: false,
			error: "STOCK_CANDLES_ROUTE_ERROR",
			ticker,
			timeframe,
		});
	}
});

// GET /api/stocks/:ticker/rating
router.get("/:ticker/rating", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);

	if (!ticker) {
		res.status(400).json({
			error: "MISSING_TICKER",
		});
		return;
	}

	try {
		const rating = await MarketDataService.getRating(ticker);

		res.json({
			ticker,
			rating,
		});
	} catch (error) {
		console.error("stock rating route error:", error);

		res.status(500).json({
			error: "STOCK_RATING_ROUTE_ERROR",
			ticker,
		});
	}
});

// GET /api/stocks/:ticker/financials
router.get("/:ticker/financials", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);
	res.setHeader("Cache-Control", "no-store, max-age=0");
	try {
		const financials = await withLiveCache(`financials:${ticker}`, 5 * 60_000, () => fetchFinancials(ticker));
		res.json({
			ticker,
			financials,
			...financials,
			items: financials.annual ?? [],
			summary: "실제 공개 재무 데이터를 불러왔습니다.",
		});
	} catch (error) {
		console.error("stock financials route error:", error);
		res.status(503).json({
			ticker,
			annual: [],
			quarterly: [],
			items: [],
			ratios: {},
			code: "FINANCIAL_PROVIDER_DELAY",
			summary: "재무 데이터 제공기관의 응답이 지연되고 있습니다.",
		});
	}
});

// GET /api/stocks/:ticker/risk
router.get("/:ticker/risk", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);

	res.json({
		ticker,
		delistingRisk: false,
		riskLevel: "normal",
		summary: "현재 확인된 상장폐지 고위험 신호는 없습니다.",
	});
});

// GET /api/stocks/:ticker/filings
router.get("/:ticker/filings", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);
	const allHistory = String(req.query.all ?? "") === "1";
	res.setHeader("Cache-Control", "no-store, max-age=0");
	try {
		const items = await withLiveCache(
			`filings:${ticker}:${allHistory ? "all" : "recent"}`,
			60_000,
			() => fetchAllFilings(ticker, allHistory),
		);
		res.json({
			ticker,
			filings: items,
			items,
			summary:
				simpleDartSummary(items[0]) +
				(items.length > 1
					? " 전체 공시 " + items.length + "건을 불러왔습니다."
					: ""),
		});
	} catch (error) {
		console.error("stock filings route error:", error);
		const items: any[] = [];
		res.json({
			ticker,
			filings: items,
			items,
			summary: /^\d{6}$/.test(ticker) ? "DART 연결을 확인해 주세요." : "SEC EDGAR 연결을 확인해 주세요.",
		});
	}
});

// GET /api/stocks/:ticker/disclosures
router.get("/:ticker/disclosures", async (req, res) => {
const ticker = normalizeTicker(req.params.ticker);
const allHistory = String(req.query.all ?? "") === "1";
res.setHeader("Cache-Control", "no-store, max-age=0");

try {
const items = await withLiveCache(
`disclosures:v4:${ticker}:${allHistory ? "all" : "recent"}`,
60_000,
() => fetchAllFilings(ticker, allHistory),
);

res.json({
ticker,
disclosures: items,
filings: items,
items,
summary: items.length
? simpleDartSummary(items[0]) +
(items.length > 1
? "   " + items.length + " ."
: "")
: "  .",
});
} catch (error) {
console.error("stock disclosures route error:", error);
res.status(502).json({
ticker,
disclosures: [],
filings: [],
items: [],
summary: /^\d{6}$/.test(ticker)
? "DART   ."
: "SEC EDGAR   .",
});
}
});

// GET /api/stocks/:ticker/news
router.get("/:ticker/news", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);
	const allHistory = String(req.query.all ?? "") === "1";
	res.setHeader("Cache-Control", "no-store, max-age=0");
	try {
		const items = await withLiveCache(
			`news:${ticker}:${allHistory ? "all" : "recent"}`,
			60_000,
			() => fetchGoogleNews(ticker, allHistory),
		);
		res.json({
			ticker,
			news: items,
			items,
			summary: items.length
				? simpleNewsSummary(items[0])
				: "최근 관련 뉴스가 없습니다.",
		});
	} catch (error) {
		console.error("stock news route error:", error);
		res.status(502).json({
			ticker,
			news: [],
			items: [],
			summary: "뉴스 제공처 연결이 잠시 지연되고 있습니다.",
		});
	}
});

function cleanFinanceCell(value: string) {
	return value
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;|&#160;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

function financeNumber(value: string | undefined) {
	if (!value) return 0;
	const normalized = value
		.replace(/,/g, "")
		.replace(/%/g, "")
		.replace(/[^0-9+\-.]/g, "");
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : 0;
}

function financeTableRows(html: string) {
	return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
		.map((row) =>
			[...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
				cleanFinanceCell(cell[1]),
			),
		)
		.filter((cells) => cells.length > 0);
}

type MarketFlowPeriod = "daily" | "weekly" | "monthly" | "yearly";

type InvestorFlowRow = {
	date: string;
	individual: number;
	institution: number;
	foreign: number;
	periodStart?: string;
	periodEnd?: string;
	tradingDays?: number;
};

function normalizeMarketFlowPeriod(value: unknown): MarketFlowPeriod {
	const period = String(value ?? "daily")
		.trim()
		.toLowerCase();

	if (
		period === "weekly" ||
		period === "monthly" ||
		period === "yearly"
	) {
		return period;
	}

	return "daily";
}

// 최신 기간 합계를 정확히 만들기 위해 필요한 일별 페이지 수입니다.
// 일별은 최근 30거래일, 주별은 최근 여러 주, 월별은 최근 여러 달,
// 년별은 현재 연도의 전체 거래일이 포함되도록 넉넉히 조회합니다.
function marketFlowPageCount(period: MarketFlowPeriod) {
	if (period === "weekly") return 2;
	if (period === "monthly") return 6;
	if (period === "yearly") return 15;
	return 2;
}

function marketPeriodKey(dateText: string, period: MarketFlowPeriod) {
	const match = dateText.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
	if (!match) return dateText;

	const [, year, month, day] = match;

	if (period === "yearly") return year;
	if (period === "monthly") return `${year}.${month}`;

	if (period === "weekly") {
		const date = new Date(
			Date.UTC(Number(year), Number(month) - 1, Number(day)),
		);
		const mondayOffset = (date.getUTCDay() + 6) % 7;
		date.setUTCDate(date.getUTCDate() - mondayOffset);

		return `${date.getUTCFullYear()}.${String(
			date.getUTCMonth() + 1,
		).padStart(2, "0")}.${String(date.getUTCDate()).padStart(2, "0")}`;
	}

	return dateText;
}

function marketPeriodLabel(key: string, period: MarketFlowPeriod) {
	if (period === "weekly") return `${key} 주`;
	return key;
}

function groupInvestorRows(
	rows: InvestorFlowRow[],
	period: MarketFlowPeriod,
): InvestorFlowRow[] {
	const sortedRows = [...rows].sort((a, b) =>
		String(b.date).localeCompare(String(a.date)),
	);

	if (period === "daily") {
		return sortedRows.slice(0, 30).map((row) => ({
			...row,
			periodStart: row.date,
			periodEnd: row.date,
			tradingDays: 1,
		}));
	}

	const grouped = new Map<
		string,
		InvestorFlowRow & { periodKey: string }
	>();

	for (const row of sortedRows) {
		const key = marketPeriodKey(row.date, period);
		const current = grouped.get(key) ?? {
			periodKey: key,
			date: marketPeriodLabel(key, period),
			periodStart: row.date,
			periodEnd: row.date,
			tradingDays: 0,
			individual: 0,
			institution: 0,
			foreign: 0,
		};

		current.individual += Number(row.individual ?? 0);
		current.institution += Number(row.institution ?? 0);
		current.foreign += Number(row.foreign ?? 0);
		current.tradingDays = Number(current.tradingDays ?? 0) + 1;

		if (!current.periodStart || row.date < current.periodStart) {
			current.periodStart = row.date;
		}
		if (!current.periodEnd || row.date > current.periodEnd) {
			current.periodEnd = row.date;
		}

		grouped.set(key, current);
	}

	return [...grouped.values()]
		.sort((a, b) =>
			String(b.periodEnd ?? b.periodKey).localeCompare(
				String(a.periodEnd ?? a.periodKey),
			),
		)
		.slice(0, 30)
		.map(({ periodKey: _periodKey, ...row }) => row);
}

function groupShortRows(rows: any[], period: MarketFlowPeriod) {
	if (period === "daily") return rows.slice(0, 30);
	const grouped = new Map<string, any>();
	for (const row of rows) {
		const key = marketPeriodKey(row.date, period);
		const current = grouped.get(key) ?? {
			date: marketPeriodLabel(key, period),
			shortVolume: 0,
			ratioTotal: 0,
			ratioCount: 0,
			balance: row.balance,
			balanceAmount: row.balanceAmount,
			balanceRatio: row.balanceRatio,
		};
		current.shortVolume += Number(row.shortVolume ?? 0);
		if (Number.isFinite(Number(row.ratio))) {
			current.ratioTotal += Number(row.ratio);
			current.ratioCount += 1;
		}
		grouped.set(key, current);
	}
	return [...grouped.values()].slice(0, 30).map((row) => ({
		date: row.date,
		shortVolume: row.shortVolume,
		ratio: row.ratioCount ? row.ratioTotal / row.ratioCount : 0,
		balance: row.balance,
		balanceAmount: row.balanceAmount,
		balanceRatio: row.balanceRatio,
	}));
}

function extractKiwoomShortRows(raw: Record<string, unknown>) {
	const arrays: unknown[][] = [];
	const visit = (value: unknown, depth = 0) => {
		if (depth > 4 || value == null) return;
		if (Array.isArray(value)) {
			arrays.push(value);
			for (const item of value.slice(0, 3)) visit(item, depth + 1);
			return;
		}
		if (typeof value === "object") {
			for (const child of Object.values(value as Record<string, unknown>)) visit(child, depth + 1);
		}
	};
	visit(raw);
	const numberValue = (value: unknown) => financeNumber(String(value ?? ""));
	const normalized = arrays
		.map((list) => list.map((item) => item as Record<string, unknown>))
		.map((list) => list.map((item) => {
			const rawDate = String(item.dt ?? item.date ?? item.base_dt ?? item.trde_dt ?? "").replace(/\D/g, "");
			const date = rawDate.length >= 8
				? `${rawDate.slice(0, 4)}.${rawDate.slice(4, 6)}.${rawDate.slice(6, 8)}`
				: "";
			const shortVolume = numberValue(
				item.shrts_qty ?? item.short_qty ?? item.shrt_qty ?? item.shortVolume ?? item.shrt_trde_qty,
			);
			const ratio = numberValue(
				item.trde_wght ?? item.shrts_qty_rt ?? item.short_ratio ?? item.shrt_rt ?? item.ratio ?? item.shrt_trde_rt,
			);
			return { date, shortVolume, ratio };
		}))
		.find((list) => list.some((row) => row.date && (row.shortVolume > 0 || row.ratio > 0)));
	return (normalized ?? []).filter((row) => row.date).slice(0, 120);
}

router.get("/:ticker/market-flow", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);
	const period = normalizeMarketFlowPeriod(req.query.period);

	res.setHeader("Cache-Control", "no-store, max-age=0");

	if (!/^\d{6}$/.test(ticker)) {
		return res.json({
			ticker,
			period,
			available: false,
			rows: [],
			totals: {
				individual: null,
				institution: null,
				foreign: null,
				program: null,
				volume: null,
				value: null,
				tradeValue: null,
			},
			message:
				"해외 종목의 투자자별 수급은 현재 제공처에서 지원하지 않습니다.",
		});
	}

	try {
		const pageCount = marketFlowPageCount(period);
		const dailyByDate = new Map<string, InvestorFlowRow>();

		for (let page = 1; page <= pageCount; page += 1) {
			const response = await fetch(
				`https://finance.naver.com/item/frgn.naver?code=${ticker}&page=${page}`,
				{
					headers: {
						"User-Agent": "Mozilla/5.0",
						Referer: "https://finance.naver.com/",
					},
				},
			);

			if (!response.ok) {
				throw new Error(`NAVER_INVESTOR_FLOW_HTTP_${response.status}`);
			}

			const html = await response.text();
			const pageRows = financeTableRows(html)
				.filter(
					(cells) =>
						/^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") &&
						cells.length >= 7,
				)
				.map((cells): InvestorFlowRow => {
					const institution = financeNumber(cells[5]);
					const foreign = financeNumber(cells[6]);

					return {
						date: cells[0],
						// 네이버 공개 표에는 개인 순매매가 별도 제공되지 않아
						// 기관+외국인 순매매의 반대값으로 계산합니다.
						individual: -(institution + foreign),
						institution,
						foreign,
					};
				});

			for (const row of pageRows) {
				if (!dailyByDate.has(row.date)) dailyByDate.set(row.date, row);
			}

			// 더 이상 일별 행이 없으면 불필요한 다음 페이지 요청을 중단합니다.
			if (pageRows.length === 0) break;
		}

		const dailyRows = [...dailyByDate.values()].sort((a, b) =>
			String(b.date).localeCompare(String(a.date)),
		);
		const rows = groupInvestorRows(dailyRows, period);
		const latest = rows[0] ?? null;

		// 중요: 모든 과거 행을 다시 더하지 않습니다.
		// 화면의 '최신 일별/주별/월별/년별 합산'은 최신 기간 한 행만 사용합니다.
		const totals = latest
			? {
					individual: Number(latest.individual ?? 0),
					institution: Number(latest.institution ?? 0),
					foreign: Number(latest.foreign ?? 0),
					program: null,
					volume: null,
					value: null,
					tradeValue: null,
				}
			: {
					individual: null,
					institution: null,
					foreign: null,
					program: null,
					volume: null,
					value: null,
					tradeValue: null,
				};

		return res.json({
			ticker,
			period,
			available: Boolean(latest),
			rows,
			totals,
			asOf: latest?.periodEnd ?? latest?.date ?? null,
			periodStart: latest?.periodStart ?? null,
			periodEnd: latest?.periodEnd ?? null,
			tradingDays: latest?.tradingDays ?? 0,
			provider: "NAVER_FINANCE",
			source: "NAVER_FINANCE",
			updatedAt: new Date().toISOString(),
			rawDailyCount: dailyRows.length,
			note:
				"개인은 기관·외국인 순매매의 반대값으로 추정한 참고치입니다. 화면 합계는 선택한 최신 기간 한 구간만 표시합니다.",
		});
	} catch (error) {
		console.error("investor flow route error:", error);

		return res.json({
			ticker,
			period,
			available: false,
			rows: [],
			totals: {
				individual: null,
				institution: null,
				foreign: null,
				program: null,
				volume: null,
				value: null,
				tradeValue: null,
			},
			message: "투자자별 수급 데이터를 불러오지 못했습니다.",
		});
	}
});

router.get("/:ticker/short-selling", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);
	const period = normalizeMarketFlowPeriod(req.query.period);
	if (!/^\d{6}$/.test(ticker)) {
		return res.json({
			ticker,
			available: false,
			rows: [],
			latest: null,
			message: "해외 공매도 데이터는 별도 제공처 연동이 필요합니다.",
		});
	}
	try {
		const headers = {
			"User-Agent": "Mozilla/5.0",
			Referer: "https://finance.naver.com/",
		};
		const [kiwoomRaw, tradeResponse, balanceResponse] = await Promise.all([
			getKiwoomShortSellingRaw(ticker).catch(() => null),
			fetch(`https://finance.naver.com/item/short_trade.naver?code=${ticker}`, {
				headers,
			}),
			fetch(
				`https://finance.naver.com/item/short_balance.naver?code=${ticker}`,
				{ headers },
			),
		]);
		const [tradeHtml, balanceHtml] = await Promise.all([
			tradeResponse.text(),
			balanceResponse.text(),
		]);
		const naverTradeRows = financeTableRows(tradeHtml)
			.filter(
				(cells) =>
					/^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") && cells.length >= 6,
			)
			.map((cells) => ({
				date: cells[0],
				shortVolume: financeNumber(cells[cells.length - 2]),
				ratio: financeNumber(cells[cells.length - 1]),
			}));
		const kiwoomTradeRows = kiwoomRaw
			? extractKiwoomShortRows(kiwoomRaw)
			: [];
		const tradeRows = kiwoomTradeRows.length ? kiwoomTradeRows : naverTradeRows;
		const balanceMap = new Map(
			financeTableRows(balanceHtml)
				.filter(
					(cells) =>
						/^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") && cells.length >= 6,
				)
				.map((cells) => [
					cells[0],
					{
						balance: financeNumber(cells[cells.length - 4]),
						balanceAmount: financeNumber(cells[cells.length - 3]),
						balanceRatio: financeNumber(cells[cells.length - 1]),
					},
				]),
		);
		const dailyRows = tradeRows
			.slice(0, 30)
			.map((row) => ({ ...row, ...(balanceMap.get(row.date) ?? {}) }));
		const rows = groupShortRows(dailyRows, period);
		const latestBalance = [...balanceMap.values()][0] ?? {};
		const latest = rows.length
			? { ...rows[0], ...latestBalance, borrowRate: null }
			: null;
		res.json({
			ticker,
			period,
			available: rows.length > 0,
			rows,
			latest,
			source: kiwoomTradeRows.length ? "KIWOOM_KA10014" : "NAVER_FINANCE",
			note: "공매도 거래는 키움 ka10014를 우선 사용하며, 대차잔고·이자율은 제공 가능한 공개 데이터만 표시합니다.",
		});
	} catch (error) {
		console.error("short selling route error:", error);
		res.json({
			ticker,
			available: false,
			rows: [],
			latest: null,
			message: "공매도 데이터를 불러오지 못했습니다.",
		});
	}
});

export default router;
