// Shared shapes for the sample-data engine and the services that expose it.
// These are the API-ready contracts. Live provider services can return
// the same shapes from Yahoo, Naver, DART, SEC, Finnhub, AlphaVantage.
import type { Market, Currency } from '../data/catalog';

export type Timeframe =
	| '1m'
	| '3m'
	| '5m'
	| '15m'
	| '30m'
	| '60m'
	| '1H'
	| '4H'
	| '12H'
	| '1D'
	| '3D'
	| '5D'
	| '15D'
	| '1W'
	| '1M'
	| '3M'
	| '6M'
	| '1Y'
	| '3Y'
	| '5Y'
	| '10Y'
	| 'ALL';

export type Rating =
	| 'STRONG_BUY'
	| 'BUY'
	| 'HOLD'
	| 'SELL'
	| 'STRONG_SELL';

export interface RatingResult {
	rating: Rating;
	confidence: number;
	score: number;
}

export type SignalTone = 'positive' | 'neutral' | 'negative';

export interface Signal {
	key: string;
	label: string;
	active: boolean;
	tone: SignalTone;
	detail: string;
}

export interface Candle {
	time: string | number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

export interface CompanyProfile {
	ticker: string;
	name: string;
	market: Market;
	currency: Currency;
	description: string;
	industry: string;
	sector: string;
	country: string;
	mainBusiness: string;
	competitors: string[];
}

export interface Quote {
	price: number;
	changeAmount: number;
	changePercent: number;
	volume: number;
	marketCap: number;
	week52High: number;
	week52Low: number;
}

export interface IndicatorSeries {
	ma20: (number | null)[];
	ma60: (number | null)[];
	ma120: (number | null)[];
	ma240: (number | null)[];
	rsi: (number | null)[];
	macd: {
		macd: (number | null)[];
		signal: (number | null)[];
		hist: (number | null)[];
	};
}

export interface FinancialRow {
	period: string;
	revenue: number;
	operatingIncome: number;
	netIncome: number;
	cash: number;
	debt: number;
	equity?: number;
	capital?: number;
}

export interface FinancialRatios {
	eps: number;
	per: number;
	pbr: number;
	roe: number;
	debtRatio: number;
}

export interface CashBurn {
	cashBalance: number;
	quarterlyBurn: number;
	survivalQuarters: number | null;
}

export type HealthLevel = 'STRONG' | 'AVERAGE' | 'WEAK';

export interface Financials {
	/** 'live' = 실제 공급자(DART/SEC/네이버/Finnhub), 'sample' = 결정적 샘플 모델. */
	source?: 'live' | 'sample';
	quarterly: FinancialRow[];
	annual: FinancialRow[];
	rows?: FinancialRow[];
	ratios: FinancialRatios;
	growth: {
		revenue: number[];
		profit: number[];
	};
	cashBurn: CashBurn;
	health: {
		level: HealthLevel;
		confidence: number;
	};
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RiskItem {
	label: string;
	score: number;
	level: RiskLevel;
	explanation: string;
}

export interface Filing {
	form: string;
	date: string;
	description: string;
	url: string;
	sentiment: 'positive' | 'negative' | 'neutral';
	events: string[];
	eventLabels: string[];
}

export interface Disclosure {
	report: string;
	date: string;
	description: string;
	url: string;
	sentiment: 'positive' | 'negative' | 'neutral';
	events: string[];
	eventLabels: string[];
}

export type RiskEventType =
	| 'DELISTING'
	| 'TRADING_SUSPENSION'
	| 'DILUTION'
	| 'CONVERTIBLE_BOND'
	| 'CAPITAL_IMPAIRMENT'
	| 'GOING_CONCERN'
	| 'OTHER';

export type RiskEventStatus = 'CURRENT' | 'WATCH' | 'HISTORICAL' | 'IGNORED';

// Evidence-driven, recency-aware risk event. Emitted by the backend risk feed
// so every screen shares the same recency judgement (requirements #14, #15, #19).
// Must stay in lockstep with the frontend RiskEvent contract in
// artifacts/stock-analyzer/src/lib/api.ts.
export interface RiskEvent {
	id: string;
	type: RiskEventType;
	label: string;
	status: RiskEventStatus;
	level: RiskLevel;
	date: string | null;
	title: string;
	summary: string;
	source: 'DART' | 'SEC' | 'NEWS' | 'SYSTEM';
	url?: string | null;
	isRecent: boolean;
	isResolved: boolean;
}

export interface RiskAnalysis {
	market: Market;
	items: RiskItem[];
	events?: RiskEvent[];
	overallScore: number;
	overallLevel: RiskLevel;
	explanation: string;
	filings?: Filing[];
	disclosures?: Disclosure[];
}

export interface NewsItem {
	title: string;
	source: string;
	sourceDomain: string;
	date: string;
	url: string;
	tone: 'positive' | 'negative' | 'neutral';
	reliability?: number;
	summary?: string;
	impact?: string;
}

export interface NewsData {
	positive: NewsItem[];
	negative: NewsItem[];
	news?: NewsItem[];
	sentimentScore: number;
}

export interface AiStrategyLeg {
	price: number;
	reason: string;
}

export interface AiStrategy {
	entry1: AiStrategyLeg;
	entry2: AiStrategyLeg;
	target: AiStrategyLeg;
	stop: AiStrategyLeg;
}

export interface AiAnalysis {
	opinion: Rating;
	opinionReason: string;
	confidence: number;
	buyReasons: string[];
	sellReasons: string[];
	shortTerm: string;
	midTerm: string;
	longTerm: string;
	targetPrice: number;
	stopLossPrice: number;
	strategy?: AiStrategy;
	conclusion: string;
	score?: number;
}
