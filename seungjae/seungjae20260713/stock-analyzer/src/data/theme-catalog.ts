import { STOCK_DIRECTORY } from "@/data/stock-directory";
import type { ThemeGroup, ThemeStock } from "@/lib/api";

type Market = "KR" | "US";

interface ThemeDefinition {
	key: string;
	label: string;
	keywords: RegExp;
	tickers?: string[];
}

const DEFINITIONS: ThemeDefinition[] = [
	{ key: "semiconductor", label: "반도체·장비", keywords: /반도체|하이닉스|micron|nvidia|amd|intel|qualcomm|broadcom|asml|lam research|kla|texas instruments|on semiconductor/i, tickers: ["005930","000660","042700","000990","NVDA","AMD","INTC","AVGO","QCOM","MU","ASML","LRCX","KLAC","TXN","ON"] },
	{ key: "ai-software", label: "AI·소프트웨어", keywords: /software|microsoft|alphabet|meta|oracle|adobe|salesforce|palantir|serviceNow|snowflake|카카오|네이버|소프트웨어|더존/i, tickers: ["MSFT","GOOGL","GOOG","META","ORCL","ADBE","CRM","PLTR","NOW","SNOW","035420","035720"] },
	{ key: "battery-ev", label: "2차전지·전기차", keywords: /배터리|에너지솔루션|삼성sdi|전기차|tesla|rivian|lucid|nio|포스코퓨처엠|에코프로|sk이노베이션/i, tickers: ["373220","006400","051910","003670","096770","011790","TSLA","RIVN","LCID","NIO"] },
	{ key: "bio-pharma", label: "바이오·제약", keywords: /바이오|제약|therapeutics|pharma|pfizer|merck|abbvie|eli lilly|moderna|gilead|johnson|unitedhealth|thermo fisher|abbott|셀트리온|삼성바이오|유한양행|한미약품|대웅제약|녹십자/i, tickers: ["207940","068270","000100","128940","185750","069620","326030","302440","006280","JNJ","PFE","MRK","ABBV","LLY","MRNA","GILD","TMO","ABT","UNH"] },
	{ key: "auto", label: "자동차·부품", keywords: /현대차|기아|모비스|motor|ford|general motors|자동차|mobis/i, tickers: ["005380","000270","012330","F","GM","TSLA","RIVN"] },
	{ key: "finance", label: "은행·증권·보험", keywords: /은행|증권|금융|보험|bank|jpmorgan|goldman|morgan stanley|citigroup|visa|mastercard|paypal|blackrock|schwab/i, tickers: ["105560","055550","086790","323410","039490","016360","071050","006800","138040","005940","001450","000060","088350","JPM","BAC","WFC","GS","MS","C","AXP","V","MA","PYPL","SCHW","BLK"] },
	{ key: "defense", label: "방산·우주항공", keywords: /한화에어로|항공우주|현대로템|방산|aerospace|defense|lockheed|boeing|northrop|raytheon/i, tickers: ["012450","047810","272210","064350","LMT","BA","NOC","RTX"] },
	{ key: "energy", label: "에너지·화학", keywords: /에너지|석유|가스|화학|솔루션|exxon|chevron|conocophillips|solar|oil|gas/i, tickers: ["096770","051910","009830","036460","XOM","CVX","COP"] },
	{ key: "internet-media", label: "인터넷·미디어·엔터", keywords: /네이버|카카오|엔터|미디어|netflix|disney|spotify|alphabet|meta|entertainment/i, tickers: ["035420","035720","NFLX","DIS","SPOT","GOOGL","META"] },
	{ key: "consumer-retail", label: "소비재·유통", keywords: /walmart|costco|target|home depot|lowe|nike|starbucks|mcdonald|coca-cola|pepsi|procter|colgate|아모레|lg생활건강|신세계|이마트|롯데/i, tickers: ["WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","KO","PEP","PG","CL"] },
	{ key: "telecom", label: "통신·네트워크", keywords: /telecom|통신|sk텔레콤|kt|lg유플러스|cisco|qualcomm/i, tickers: ["017670","030200","032640","CSCO","QCOM","T","VZ","TMUS"] },
	{ key: "shipping-logistics", label: "조선·해운·물류", keywords: /조선|해운|물류|대한항공|아시아나|한진|현대미포|shipping|logistics|airlines/i, tickers: ["267250","010620","003490","020560","180640","000120"] },
	{ key: "steel-material", label: "철강·소재", keywords: /철강|제철|포스코|steel|materials|chemical/i, tickers: ["005490","004020","003670","011790"] },
	{ key: "display-electronics", label: "전자·디스플레이", keywords: /전자|디스플레이|가전|apple|sony|display/i, tickers: ["005930","066570","034220","AAPL"] },
	{ key: "gaming", label: "게임·콘텐츠", keywords: /게임|game|엔씨|크래프톤|넷마블|take-two|electronic arts|roblox/i, tickers: ["036570","259960","251270","TTWO","EA","RBLX"] },
	{ key: "cloud-security", label: "클라우드·보안", keywords: /cloud|security|palo alto|crowdstrike|fortinet|amazon|microsoft|oracle|snowflake/i, tickers: ["AMZN","MSFT","ORCL","PANW","CRWD","FTNT","SNOW"] },
	{ key: "quantum", label: "양자컴퓨팅", keywords: /quantum|rigetti|ionq|d-wave/i, tickers: ["RGTI","IONQ","QBTS"] },
	{ key: "holding", label: "지주·복합기업", keywords: /지주|홀딩스|holding|삼성물산|sk$|lg$|cj$|한화$/i, tickers: ["028260","034730","003550","001040","000880","BRK.B"] },
];

function marketOf(ticker: string): Market {
	return /^\d{6}$/.test(ticker) ? "KR" : "US";
}

export function buildLocalThemes(market: Market): ThemeGroup[] {
	const rows = STOCK_DIRECTORY.filter((entry) => marketOf(entry.ticker) === market);
	const buckets = new Map(DEFINITIONS.map((definition) => [definition.key, [] as ThemeStock[]]));
	const etc: ThemeStock[] = [];

	for (const entry of rows) {
		const haystack = `${entry.ticker} ${entry.name}`;
		const matched = DEFINITIONS.filter((definition) =>
			definition.key !== "holding" || true,
		).filter((definition) => definition.keywords.test(haystack) || definition.tickers?.includes(entry.ticker));
		const targets = matched.length ? matched : [];
		const stock: ThemeStock = {
			ticker: entry.ticker,
			name: entry.name,
			market,
			currency: market === "KR" ? "KRW" : "USD",
			price: 0,
			changePercent: 0,
		};
		if (!targets.length) etc.push(stock);
		else targets.forEach((definition) => buckets.get(definition.key)?.push(stock));
	}

	const groups = DEFINITIONS.map((definition) => {
		const stocks = buckets.get(definition.key) ?? [];
		const unique = [...new Map(stocks.map((stock) => [stock.ticker, stock])).values()];
		return { key: definition.key, label: definition.label, count: unique.length, stocks: unique };
	}).filter((group) => group.count > 0);

	if (etc.length) groups.push({ key: "etc", label: "기타·종합", count: etc.length, stocks: etc });
	return groups;
}

export function mergeThemeGroups(local: ThemeGroup[], remote: ThemeGroup[]): ThemeGroup[] {
	const remoteStock = new Map<string, ThemeStock>();
	remote.forEach((group) => group.stocks.forEach((stock) => remoteStock.set(stock.ticker, stock)));
	const result = local.map((group) => {
		const stocks = group.stocks.map((stock) => ({ ...stock, ...(remoteStock.get(stock.ticker) ?? {}) }));
		return { ...group, count: stocks.length, stocks };
	});
	for (const group of remote) {
		if (result.some((item) => item.key === group.key || item.label === group.label)) continue;
		result.push(group);
	}
	return result;
}
