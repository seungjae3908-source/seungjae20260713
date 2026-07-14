import { Router, type IRouter } from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MarketDataService } from "../services/market-data.service";
import { placeKiwoomDomesticOrder } from "../providers/kiwoom";

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
router.get("/server-ip", async (_req, res) => {
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
	if (!dartCorpMapCache) {
		const response = await fetch(
			"https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=" +
				encodeURIComponent(apiKey),
		);
		if (!response.ok) throw new Error("DART_CORP_CODE_HTTP_" + response.status);
		const xml = await response.text();
		const map = new Map<string, string>();
		for (const block of xml.match(/<list>[\s\S]*?<\/list>/g) ?? []) {
			const stockCode = xmlTag(block, "stock_code");
			const corpCode = xmlTag(block, "corp_code");
			if (stockCode && corpCode) map.set(stockCode, corpCode);
		}
		dartCorpMapCache = map;
	}
	return dartCorpMapCache.get(ticker) ?? "";
}

async function fetchDartFilings(ticker: string) {
	const apiKey = String(process.env.DART_API_KEY ?? "").trim();
	const fallback = {
		title: "DART에서 " + ticker + " 공시 전체보기",
		report_nm: "공식 전자공시 검색",
		date: "실시간",
		rcept_dt: "",
		url: "https://dart.fss.or.kr/dsab001/main.do",
		source: "DART",
	};

	if (!apiKey || !/^\d{6}$/.test(ticker)) return [fallback];

	const corpCode = await getDartCorpCode(ticker, apiKey);
	if (!corpCode) return [fallback];

	const items: any[] = [];
	let pageNo = 1;
	let totalPage = 1;

	do {
		const query = new URLSearchParams({
			crtfc_key: apiKey,
			corp_code: corpCode,
			bgn_de: "19990101",
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
	} while (pageNo <= totalPage && pageNo <= 100);

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

	return result.length ? result : [fallback];
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

async function fetchAllFilings(ticker: string) {
	return /^\d{6}$/.test(ticker)
		? fetchDartFilings(ticker)
		: fetchSecFilings(ticker);
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
	if (!periods.length) return { annual: [], quarterly: [], ratios: {} };

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
		try { return await fetchDartFinancials(ticker); }
		catch (error) { console.warn("DART financial fallback:", error); return fetchNaverFinancials(ticker); }
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

async function fetchGoogleNews(ticker: string) {
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

	return (xml.match(/<item>[\s\S]*?<\/item>/g) ?? [])
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
		.filter((item) => item.title && item.url);
}

const autoTradeExecuted = new Set<string>();
interface AutoTradePosition {
	ticker: string;
	quantity: number;
	entryPrice: number;
	stopPrice: number;
	targetPrice: number;
	openedAt: string;
}
const autoTradePositions = new Map<string, AutoTradePosition>();
const autoTradePositionFile = path.resolve(
	process.env.KIWOOM_AUTO_TRADE_POSITION_FILE?.trim() ||
		"data/auto-trade-positions.json",
);
let autoTradePositionsLoaded = false;

async function ensureAutoTradePositionsLoaded() {
	if (autoTradePositionsLoaded) return;
	autoTradePositionsLoaded = true;

	try {
		const parsed = JSON.parse(await readFile(autoTradePositionFile, "utf8"));
		if (!Array.isArray(parsed)) return;
		for (const raw of parsed) {
			const position = raw as Partial<AutoTradePosition>;
			const ticker = normalizeTicker(position.ticker);
			const quantity = Math.trunc(Number(position.quantity));
			const entryPrice = Number(position.entryPrice);
			const stopPrice = Number(position.stopPrice);
			const targetPrice = Number(position.targetPrice);
			if (
				/^\d{6}$/.test(ticker) &&
				quantity > 0 &&
				entryPrice > 0 &&
				stopPrice > 0 &&
				targetPrice > 0
			) {
				autoTradePositions.set(ticker, {
					ticker,
					quantity,
					entryPrice,
					stopPrice,
					targetPrice,
					openedAt: String(position.openedAt ?? new Date().toISOString()),
				});
			}
		}
	} catch {
		// 첫 실행이거나 저장 파일이 없으면 빈 상태로 시작합니다.
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

function kstParts() {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Seoul",
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

function koreanMarketOpenNow() {
	if (process.env.KIWOOM_AUTO_TRADE_ALLOW_OFF_HOURS === "true") return true;
	const parts = kstParts();
	if (["Sat", "Sun"].includes(parts.weekday)) return false;
	const minutes = Number(parts.hour) * 60 + Number(parts.minute);
	return minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

// POST /api/stocks/auto-trade/execute
router.post("/auto-trade/execute", async (req, res) => {
	const enabled = process.env.KIWOOM_AUTO_TRADE_ENABLED === "true";
	const configuredKey = String(process.env.KIWOOM_AUTO_TRADE_KEY ?? "").trim();
	const suppliedKey = String(req.header("X-Auto-Trade-Key") ?? "").trim();

	if (!enabled) {
		return res.status(403).json({ ok: false, message: "서버의 실제 자동매매 기능이 꺼져 있습니다." });
	}
	if (!configuredKey || suppliedKey !== configuredKey) {
		return res.status(401).json({ ok: false, message: "자동매매 실행키가 올바르지 않습니다." });
	}
	if (!koreanMarketOpenNow()) {
		return res.status(409).json({ ok: false, message: "국내 정규장 주문 가능 시간이 아닙니다." });
	}

	await ensureAutoTradePositionsLoaded();

	const candidates = Array.isArray(req.body?.candidates)
		? req.body.candidates.slice(0, 5)
		: [];
	const investmentPerTrade = Math.max(1, Number(req.body?.investmentPerTrade ?? 0));
	const stopLossPercent = Math.max(0.1, Number(req.body?.stopLossPercent ?? 5));
	const takeProfitPercent = Math.max(0.1, Number(req.body?.takeProfitPercent ?? 10));
	const day = `${kstParts().year}-${kstParts().month}-${kstParts().day}`;
	const results: any[] = [];

	for (const candidate of candidates) {
		const ticker = normalizeTicker(candidate?.ticker);
		const price = Number(candidate?.price ?? 0);
		const probability = Number(candidate?.probability ?? 0);
		const key = `${day}:${ticker}:BUY`;

		if (!/^\d{6}$/.test(ticker)) {
			results.push({ ticker, ok: false, skipped: true, message: "국내 주식만 실제 자동주문을 지원합니다." });
			continue;
		}
		if (!Number.isFinite(price) || price <= 0 || probability <= 0) {
			results.push({ ticker, ok: false, skipped: true, message: "가격 또는 확률 데이터가 부족합니다." });
			continue;
		}
		if (autoTradeExecuted.has(key)) {
			results.push({ ticker, ok: true, skipped: true, message: "오늘 이미 주문한 종목입니다." });
			continue;
		}

		const quantity = Math.floor(investmentPerTrade / price);
		if (quantity < 1) {
			results.push({ ticker, ok: false, skipped: true, message: "주문금액이 현재가보다 작습니다." });
			continue;
		}

		try {
			const order = await placeKiwoomDomesticOrder({
				ticker,
				side: "buy",
				quantity,
				orderType: "market",
			});
			const stopPrice = price * (1 - stopLossPercent / 100);
			const targetPrice = price * (1 + takeProfitPercent / 100);
			autoTradeExecuted.add(key);
			autoTradePositions.set(ticker, {
				ticker,
				quantity,
				entryPrice: price,
				stopPrice,
				targetPrice,
				openedAt: new Date().toISOString(),
			});
			await saveAutoTradePositions();
			results.push({
				ticker,
				ok: true,
				quantity,
				orderNo: order.orderNo,
				stopPrice,
				targetPrice,
				message: "시장가 매수 주문을 전송했습니다.",
			});
		} catch (error) {
			results.push({
				ticker,
				ok: false,
				quantity,
				message: error instanceof Error ? error.message : "키움 주문 전송 실패",
			});
		}
	}

	const completed = results.filter((item) => item.ok && !item.skipped).length;
	return res.json({
		ok: completed > 0 || results.every((item) => item.skipped),
		message: completed > 0 ? `${completed}개 종목 주문을 전송했습니다.` : "신규 주문이 전송되지 않았습니다.",
		results,
	});
});

let autoTradeMonitorRunning = false;

async function runAutoTradeMonitor() {
	if (autoTradeMonitorRunning) {
		return { results: [] as any[], activePositions: autoTradePositions.size };
	}
	autoTradeMonitorRunning = true;

	try {
		await ensureAutoTradePositionsLoaded();
		const results: any[] = [];

		for (const position of [...autoTradePositions.values()]) {
			try {
				const quote: any = await MarketDataService.getQuoteRow(position.ticker);
				const currentPrice = Math.abs(
					Number(quote?.price ?? quote?.currentPrice ?? quote?.cur_prc ?? 0),
				);
				if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
					results.push({
						ticker: position.ticker,
						ok: false,
						skipped: true,
						message: "현재가 확인 실패",
					});
					continue;
				}

				const reason =
					currentPrice <= position.stopPrice
						? "손절가 도달"
						: currentPrice >= position.targetPrice
							? "목표가 도달"
							: "보유 유지";

				if (reason === "보유 유지") {
					results.push({
						ticker: position.ticker,
						ok: true,
						skipped: true,
						currentPrice,
						stopPrice: position.stopPrice,
						targetPrice: position.targetPrice,
						message: reason,
					});
					continue;
				}

				const order = await placeKiwoomDomesticOrder({
					ticker: position.ticker,
					side: "sell",
					quantity: position.quantity,
					orderType: "market",
				});
				autoTradePositions.delete(position.ticker);
				await saveAutoTradePositions();
				results.push({
					ticker: position.ticker,
					ok: true,
					quantity: position.quantity,
					orderNo: order.orderNo,
					currentPrice,
					message: `${reason}로 시장가 매도 주문을 전송했습니다.`,
				});
			} catch (error) {
				results.push({
					ticker: position.ticker,
					ok: false,
					message: error instanceof Error ? error.message : "자동청산 주문 실패",
				});
			}
		}

		return { results, activePositions: autoTradePositions.size };
	} finally {
		autoTradeMonitorRunning = false;
	}
}

// 서버 프로세스가 실행 중이면 화면을 닫아도 30초마다 손절·목표가를 확인합니다.
const autoTradeMonitorTimer = setInterval(() => {
	if (
		process.env.KIWOOM_AUTO_TRADE_ENABLED === "true" &&
		koreanMarketOpenNow()
	) {
		void runAutoTradeMonitor().catch((error) =>
			console.error("auto trade background monitor error:", error),
		);
	}
}, 30_000);
autoTradeMonitorTimer.unref?.();

// POST /api/stocks/auto-trade/monitor
router.post("/auto-trade/monitor", async (req, res) => {
	const enabled = process.env.KIWOOM_AUTO_TRADE_ENABLED === "true";
	const configuredKey = String(process.env.KIWOOM_AUTO_TRADE_KEY ?? "").trim();
	const suppliedKey = String(req.header("X-Auto-Trade-Key") ?? "").trim();

	if (!enabled) {
		return res.status(403).json({
			ok: false,
			message: "서버의 실제 자동매매 기능이 꺼져 있습니다.",
		});
	}
	if (!configuredKey || suppliedKey !== configuredKey) {
		return res.status(401).json({
			ok: false,
			message: "자동매매 실행키가 올바르지 않습니다.",
		});
	}
	if (!koreanMarketOpenNow()) {
		return res.json({
			ok: true,
			message: "장 시간이 아니어서 자동청산 확인을 건너뜁니다.",
			results: [],
		});
	}

	const monitored = await runAutoTradeMonitor();
	return res.json({
		ok: monitored.results.every((item) => item.ok),
		activePositions: monitored.activePositions,
		message: monitored.activePositions
			? `자동매매 보유 ${monitored.activePositions}개를 감시 중입니다.`
			: "감시 중인 자동매매 보유 종목이 없습니다.",
		results: monitored.results,
	});
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
		const profile = await MarketDataService.getCompanyProfile(ticker);

		res.json(profile);
	} catch (error) {
		console.error("stock profile route error:", error);

		res.status(500).json({
			error: "STOCK_PROFILE_ROUTE_ERROR",
			ticker,
		});
	}
});

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
		const profile = await MarketDataService.getCompanyProfile(ticker);

		res.json(profile);
	} catch (error) {
		console.error("stock company route error:", error);

		res.status(500).json({
			error: "STOCK_COMPANY_ROUTE_ERROR",
			ticker,
		});
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
		const candles = await MarketDataService.getCandles(
			ticker,
			timeframe as any,
		);

		res.json({
			ticker,
			timeframe,
			candles,
		});
	} catch (error) {
		console.error("stock candles route error:", error);

		res.status(500).json({
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
		res.json({ ticker, annual: [], quarterly: [], items: [], ratios: {}, summary: "재무제표 데이터를 불러오지 못했습니다." });
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
	res.setHeader("Cache-Control", "no-store, max-age=0");
	try {
		const items = await withLiveCache(`filings:${ticker}`, 60_000, () => fetchAllFilings(ticker));
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
	res.setHeader("Cache-Control", "no-store, max-age=0");
	try {
		const items = await withLiveCache(`filings:${ticker}`, 60_000, () => fetchAllFilings(ticker));
		res.json({
			ticker,
			disclosures: items,
			items,
			summary: simpleDartSummary(items[0]),
		});
	} catch (error) {
		console.error("stock disclosures route error:", error);
		res.json({
			ticker,
			disclosures: [],
			items: [],
			summary: /^\d{6}$/.test(ticker) ? "DART 연결을 확인해 주세요." : "SEC EDGAR 연결을 확인해 주세요.",
		});
	}
});

// GET /api/stocks/:ticker/news
router.get("/:ticker/news", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);
	res.setHeader("Cache-Control", "no-store, max-age=0");
	try {
		const items = await withLiveCache(`news:${ticker}`, 60_000, () => fetchGoogleNews(ticker));
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

function groupInvestorRows(rows: any[], period: string) {
	const size =
		period === "weekly"
			? 5
			: period === "monthly"
				? 20
				: period === "yearly"
					? 240
					: 1;
	if (size === 1) return rows.slice(0, 30);
	const grouped = [];
	for (let i = 0; i < rows.length; i += size) {
		const chunk = rows.slice(i, i + size);
		if (!chunk.length) continue;
		grouped.push({
			date: chunk[0].date,
			individual: chunk.reduce((sum, row) => sum + row.individual, 0),
			institution: chunk.reduce((sum, row) => sum + row.institution, 0),
			foreign: chunk.reduce((sum, row) => sum + row.foreign, 0),
		});
	}
	return grouped.slice(0, 30);
}

router.get("/:ticker/market-flow", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);
	const period = String(req.query.period ?? "daily");
	if (!/^\d{6}$/.test(ticker)) {
		return res.json({
			ticker,
			period,
			available: false,
			rows: [],
			totals: { individual: 0, institution: 0, foreign: 0 },
			message: "해외 종목의 투자자별 수급은 현재 제공처에서 지원하지 않습니다.",
		});
	}
	try {
		const response = await fetch(
			`https://finance.naver.com/item/frgn.naver?code=${ticker}&page=1`,
			{
				headers: {
					"User-Agent": "Mozilla/5.0",
					Referer: "https://finance.naver.com/",
				},
			},
		);
		const html = await response.text();
		const dailyRows = financeTableRows(html)
			.filter(
				(cells) =>
					/^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") && cells.length >= 7,
			)
			.map((cells) => {
				const institution = financeNumber(cells[5]);
				const foreign = financeNumber(cells[6]);
				return {
					date: cells[0],
					individual: -(institution + foreign),
					institution,
					foreign,
				};
			});
		const rows = groupInvestorRows(dailyRows, period);
		const totals = rows.reduce(
			(acc, row) => ({
				individual: acc.individual + row.individual,
				institution: acc.institution + row.institution,
				foreign: acc.foreign + row.foreign,
			}),
			{ individual: 0, institution: 0, foreign: 0 },
		);
		res.json({
			ticker,
			period,
			available: rows.length > 0,
			rows,
			totals,
			note: "개인은 기관·외국인 순매매의 반대값으로 추정한 참고치입니다.",
		});
	} catch (error) {
		console.error("investor flow route error:", error);
		res.json({
			ticker,
			period,
			available: false,
			rows: [],
			totals: { individual: 0, institution: 0, foreign: 0 },
			message: "투자자별 수급 데이터를 불러오지 못했습니다.",
		});
	}
});

router.get("/:ticker/short-selling", async (req, res) => {
	const ticker = normalizeTicker(req.params.ticker);
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
		const [tradeResponse, balanceResponse] = await Promise.all([
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
		const tradeRows = financeTableRows(tradeHtml)
			.filter(
				(cells) =>
					/^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") && cells.length >= 6,
			)
			.map((cells) => ({
				date: cells[0],
				shortVolume: financeNumber(cells[cells.length - 2]),
				ratio: financeNumber(cells[cells.length - 1]),
			}));
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
		const rows = tradeRows
			.slice(0, 30)
			.map((row) => ({ ...row, ...(balanceMap.get(row.date) ?? {}) }));
		const latestBalance = [...balanceMap.values()][0] ?? {};
		const latest = rows.length
			? { ...rows[0], ...latestBalance, borrowRate: null }
			: null;
		res.json({
			ticker,
			available: rows.length > 0,
			rows,
			latest,
			note: "대차 이자율은 현재 제공처가 공개하지 않아 미제공으로 표시됩니다.",
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
