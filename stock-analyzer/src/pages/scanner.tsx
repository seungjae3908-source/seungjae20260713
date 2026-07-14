import {
	useEffect,
	useMemo,
	useState,
	type MouseEvent,
	type ReactNode,
} from "react";
import { useLocation } from "wouter";
import {
	ChevronRight,
	HelpCircle,
	Plus,
	RefreshCw,
	Search,
	Star,
	TrendingDown,
	TrendingUp,
	X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { BottomNav } from "@/components/bottom-nav";
import {
	classifyStock,
	stockClassBadgeClass,
	type StockGrade,
} from "@/lib/stock-classifier";
import {
	displayStockName,
	formatAppPercent,
	formatAppPrice,
	normalizePlanText,
} from "@/lib/stock-display";
import { cn } from "@/lib/utils";
import {
	estimateAutoTradeProbability,
	executeAutoTradeCandidates,
	loadAutoTradeSettings,
	monitorAutoTradePositions,
	saveAutoTradeCandidates,
	saveAutoTradeSettings,
	type AutoTradeCandidate,
	type AutoTradeSettings,
} from "@/lib/auto-trading";

type AnyObj = Record<string, unknown>;
type MarketFilter = "KR" | "US";
type ThresholdOption = number;

// 지표 찾기 모달에서 제시하는 기본 지표 목록.
// 실제 스캔 응답의 supportedIndicators가 있으면 그것을 우선 사용한다.
const SEED_INDICATORS = [
	"바닥권매집",
	"박스권 하단",
	"단기 추세 전환",
	"거래량 증가",
	"돌파 직전",
	"RSI 과매도 반등",
	"MACD 골든크로스",
	"거래대금 증가",
	"시총",
	"5일선 돌파",
	"20일선 회복",
	"60일선 돌파",
	"120일선 돌파",
	"240일선 돌파",
	"20·60일 골든크로스",
	"볼린저밴드 상단 돌파",
	"스토캐스틱 골든크로스",
	"OBV 상승",
	"외국인 순매수",
	"기관 순매수",
	"RSI 과열",
	"신고가 근접",
	"낙폭과대",
	"저평가",
	"PER 낮음",
	"PBR 낮음",
	"ROE 개선",
	"AI 점수 상위",
	"공시 호재",
	"뉴스 호재",
];

const DEFAULT_SELECTED = ["거래량 증가", "5일선 돌파", "AI 점수 상위"];

const STRATEGY_PRESETS = [
	{
		key: "scalp",
		label: "단타",
		desc: "당일 수급과 짧은 돌파에 집중",
		indicators: [
			"거래량 증가",
			"거래대금 증가",
			"5일선 돌파",
			"단기 추세 전환",
		],
	},
	{
		key: "swing",
		label: "스윙",
		desc: "수일~수주 추세 전환과 돌파",
		indicators: [
			"거래량 증가",
			"20일선 회복",
			"MACD 골든크로스",
			"AI 점수 상위",
		],
	},
	{
		key: "long",
		label: "중장기",
		desc: "실적과 장기 추세가 함께 좋은 종목",
		indicators: [
			"60일선 돌파",
			"120일선 돌파",
			"저평가",
			"ROE 개선",
			"AI 점수 상위",
		],
	},
] as const;

const THRESHOLD_OPTIONS: ThresholdOption[] = [100, 150, 200];
const DEFAULT_THRESHOLD: ThresholdOption = 150;
const LOOKBACK_OPTIONS = [
	{ label: "직전 거래일", value: 1 },
	{ label: "5일 전", value: 5 },
	{ label: "1개월 전", value: 20 },
] as const;
const THRESHOLD_STORAGE_KEY = "scanner.threshold.v1";

const MARKET_OPTIONS: MarketFilter[] = ["KR", "US"];
const DEFAULT_MARKET: MarketFilter = "KR";
const MARKET_STORAGE_KEY = "scanner-market";

// 임계값이 영향을 주는 지표 (거래량/거래대금 증가 계열)
const VOLUME_INDICATORS = ["거래량 증가"];
const MARKET_CAP_INDICATORS = ["시총"];
const MARKET_CAP_OPTIONS = [
	1_000_000_000, 5_000_000_000, 10_000_000_000,
] as const;
const TRADING_VALUE_INDICATORS = ["거래대금 증가"];

const HELP: Record<string, { why: string; watch: string }> = {
	바닥권매집: {
		why: "가격은 크게 움직이지 않는데 거래량이 쌓이면 큰 변동 전 준비 구간일 수 있습니다.",
		watch: "저점 이탈 여부, 거래량 증가, 돌파 시 캔들 크기를 함께 확인합니다.",
	},
	"거래량 증가": {
		why: "수급이 들어오는 종목을 빠르게 찾기 위한 핵심 조건입니다.",
		watch: "가격도 같이 상승하는지, 윗꼬리만 남기고 밀리는지 확인합니다.",
	},
	"거래대금 증가": {
		why: "실제 돈이 많이 들어온 종목을 찾기 좋습니다.",
		watch: "소형주 장난성 거래량보다 거래대금이 동반되는지 봅니다.",
	},
	시총: {
		why: "회사의 전체 시장가치를 기준으로 종목 규모를 골라냅니다.",
		watch:
			"소형주 변동성을 줄이거나 원하는 규모 이상의 기업만 찾을 때 사용합니다.",
	},
	"5일선 돌파": {
		why: "초단기 평균 가격대를 회복하면 단기 반등이 시작되는 신호일 수 있습니다.",
		watch: "5일선 위에서 종가가 유지되는지, 거래량이 붙는지 확인합니다.",
	},
	"20일선 회복": {
		why: "단기 추세 회복 기준으로 많이 씁니다.",
		watch: "20일선 위에서 종가가 유지되는지 봅니다.",
	},
	"60일선 돌파": {
		why: "중기 추세 회복 여부를 확인하는 기준입니다.",
		watch: "거래량 동반 돌파인지 확인합니다.",
	},
	"120일선 돌파": {
		why: "장기 하락 추세가 바뀌는지 볼 때 씁니다.",
		watch: "돌파 후 눌림에서 120일선을 지키는지 봅니다.",
	},
	"240일선 돌파": {
		why: "약 1년 평균 가격선을 회복했는지 보는 장기 추세 지표입니다.",
		watch:
			"장기 투자 후보를 찾을 때 거래량을 동반해 240일선 위에 안착하는지 봅니다.",
	},
	"20·60일 골든크로스": {
		why: "20일선이 60일선을 위로 통과해 중기 상승 전환 가능성을 보여주는 지표입니다.",
		watch:
			"스윙·중기 진입 후보를 찾을 때 거래량과 가격 위치를 함께 확인합니다.",
	},
	"볼린저밴드 상단 돌파": {
		why: "가격이 최근 변동 범위의 상단을 돌파해 강한 추세가 시작될 가능성을 보는 지표입니다.",
		watch:
			"추격매수보다 거래량 동반 여부와 돌파 후 지지 여부를 확인할 때 사용합니다.",
	},
	"스토캐스틱 골든크로스": {
		why: "단기 과매도 구간에서 매수선이 신호선을 상향 돌파하는 반등 지표입니다.",
		watch:
			"단기 반등 후보를 찾되 장기 하락 추세에서는 신호 실패 가능성을 주의합니다.",
	},
	"OBV 상승": {
		why: "가격보다 거래량 흐름을 누적해 매수세가 쌓이는지 확인하는 수급 지표입니다.",
		watch: "가격 횡보 중 OBV가 먼저 상승할 때 매집 가능성을 살펴봅니다.",
	},
	"외국인 순매수": {
		why: "외국인 투자자의 순매수 흐름이 이어지는 종목을 찾는 수급 지표입니다.",
		watch: "하루 수치보다 여러 거래일 연속 순매수인지 확인할 때 유용합니다.",
	},
	"기관 순매수": {
		why: "기관 투자자의 순매수 흐름이 이어지는 종목을 찾는 수급 지표입니다.",
		watch: "연기금·투신 등 주체별 지속성과 가격 추세를 함께 확인합니다.",
	},
	"RSI 과매도 반등": {
		why: "너무 많이 빠진 종목의 기술적 반등 구간을 찾습니다.",
		watch: "RSI만 보지 말고 거래량과 지지선을 같이 봅니다.",
	},
	"RSI 과열": {
		why: "단기 과열로 추격매수 위험이 큰 종목을 걸러낼 수 있습니다.",
		watch: "70 이상이면 과열 가능성이 있으니 눌림 여부를 봅니다.",
	},
	"MACD 골든크로스": {
		why: "추세 전환 가능성을 확인하는 보조 지표입니다.",
		watch: "신호가 늦게 나올 수 있어 가격 위치를 함께 확인합니다.",
	},
	저평가: {
		why: "재무 대비 가격이 낮은 종목을 찾기 위한 조건입니다.",
		watch: "싼 이유가 실적 악화나 부채인지 반드시 확인합니다.",
	},
	"PER 낮음": {
		why: "이익 대비 주가가 낮은 종목을 찾습니다.",
		watch: "일회성 이익 때문에 PER이 낮아진 것은 아닌지 확인합니다.",
	},
	"PBR 낮음": {
		why: "자산 대비 주가가 낮은 종목을 찾습니다.",
		watch: "자산의 질과 부채 부담을 같이 봅니다.",
	},
	"ROE 개선": {
		why: "자본 대비 이익 창출력이 좋아지는 종목을 찾습니다.",
		watch: "일시적 개선인지 지속 가능한 개선인지 확인합니다.",
	},
	"AI 점수 상위": {
		why: "여러 지표를 종합해 상대적으로 좋은 종목을 빠르게 고릅니다.",
		watch: "점수만 믿지 말고 차트, 재무, 공시 리스크를 같이 봅니다.",
	},
	"공시 호재": {
		why: "계약, 수주, 승인, 자사주 등 가격에 영향을 줄 수 있는 공시를 찾습니다.",
		watch: "공시 원문에서 금액, 기간, 조건을 확인합니다.",
	},
	"뉴스 호재": {
		why: "시장 관심을 끌 수 있는 뉴스성 재료를 찾습니다.",
		watch: "이미 주가에 반영됐는지, 후속 재료가 있는지 봅니다.",
	},
	"단기 추세 전환": {
		why: "하락하던 흐름이 위로 방향을 바꾸는 초입을 찾습니다.",
		watch: "전환이 일시적 반등인지 추세 전환인지 거래량으로 확인합니다.",
	},
	"돌파 직전": {
		why: "저항선 돌파 전 거래량과 가격이 모이는 종목을 찾습니다.",
		watch: "돌파 실패 시 빠르게 손절할 기준을 정합니다.",
	},
	"박스권 하단": {
		why: "손절폭을 짧게 잡고 반등을 노릴 수 있는 구간입니다.",
		watch: "하단 이탈 시 손절 기준을 먼저 정합니다.",
	},
	"신고가 근접": {
		why: "전 고점 부근까지 올라온 강세 종목을 찾습니다.",
		watch: "신고가 돌파 실패 시 매물 부담이 커질 수 있습니다.",
	},
	낙폭과대: {
		why: "단기간에 과하게 하락한 종목의 반등 후보를 찾습니다.",
		watch: "실적 악화나 악재가 원인이면 추가 하락도 가능합니다.",
	},
};

function getHelp(label: string) {
	return (
		HELP[label] ?? {
			why: `${label} 조건은 종목을 고를 때 보조 기준으로 사용합니다.`,
			watch:
				"단독으로 판단하지 말고 가격, 거래량, 추세, 공시를 함께 확인합니다.",
		}
	);
}

function toNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;

	if (typeof value === "string") {
		const parsed = Number(value.replace(/,/g, "").replace(/%/g, ""));

		if (Number.isFinite(parsed)) return parsed;
	}

	return null;
}

function marketCapOf(card: AnyObj): number | null {
	const raw =
		card.marketCap ??
		card.market_cap ??
		card.mrkt_cap ??
		card.marketValue ??
		card.totalMarketValue;
	const direct = toNumber(raw);
	if (direct !== null) return direct;
	if (typeof raw !== "string") return null;
	const compact = raw.replace(/,/g, "").trim();
	const value = Number.parseFloat(compact);
	if (!Number.isFinite(value)) return null;
	if (compact.includes("조")) return value * 1_000_000_000_000;
	if (compact.includes("억")) return value * 100_000_000;
	return value;
}

function scoreOf(card: AnyObj): number {
	return (
		toNumber(card.score) ??
		toNumber(card.aiScore) ??
		toNumber((card.rating as AnyObj | undefined)?.score) ??
		50
	);
}

function cardMarket(card: AnyObj): "KR" | "US" {
	return card.market === "US" ? "US" : "KR";
}

function cardCurrency(card: AnyObj): "KRW" | "USD" {
	return card.currency === "USD" ? "USD" : "KRW";
}

function matchedLabels(card: AnyObj): string[] {
	if (Array.isArray(card.matched)) return card.matched.map(String);
	if (Array.isArray(card.signals)) return card.signals.map(String);

	return [];
}

function resultMatchesSelectedAnd(card: AnyObj, selected: string[]) {
	if (!selected.length) return false;

	const matched = matchedLabels(card);

	if (!matched.length) return false;

	return selected.every((label) => matched.includes(label));
}

function sortByMatch(cards: AnyObj[], selected: string[]) {
	return [...cards].sort((a, b) => {
		const aMatched = matchedLabels(a).filter((label) =>
			selected.includes(label),
		).length;
		const bMatched = matchedLabels(b).filter((label) =>
			selected.includes(label),
		).length;

		if (aMatched !== bMatched) return bMatched - aMatched;

		return scoreOf(b) - scoreOf(a);
	});
}

function heuristicIndicatorMatch(
	card: AnyObj,
	label: string,
	volumeThreshold: ThresholdOption,
	tradingValueThreshold: ThresholdOption,
) {
	const change = toNumber(card.changePercent) ?? toNumber(card.changeRate) ?? 0;
	const score = scoreOf(card);
	const volume = toNumber(card.volume) ?? 0;
	const tradingValue = toNumber(card.tradingValue) ?? 0;
	const volumeRatioRaw =
		toNumber(card.volumeRatio) ??
		toNumber(card.volumeMultiple) ??
		(volume > 0 ? 1.5 : 0);
	const tradingRatioRaw =
		toNumber(card.tradingValueRatio) ?? (tradingValue > 0 ? 1.5 : 0);
	const volumePercent =
		volumeRatioRaw <= 10 ? volumeRatioRaw * 100 : volumeRatioRaw;
	const tradingPercent =
		tradingRatioRaw <= 10 ? tradingRatioRaw * 100 : tradingRatioRaw;
	const reason = String(card.reason ?? card.summary ?? "").toLowerCase();

	if (VOLUME_INDICATORS.includes(label))
		return volumePercent >= volumeThreshold;
	if (TRADING_VALUE_INDICATORS.includes(label))
		return tradingPercent >= tradingValueThreshold;
	if (label === "AI 점수 상위") return score >= 55;
	if (label === "RSI 과열" || label === "신고가 근접") return change >= 3;
	if (label === "RSI 과매도 반등" || label === "낙폭과대") return change <= -3;
	if (
		label.includes("돌파") ||
		label.includes("회복") ||
		label === "단기 추세 전환"
	)
		return change > 0;
	if (
		label === "저평가" ||
		label === "PER 낮음" ||
		label === "PBR 낮음" ||
		label === "ROE 개선"
	)
		return score >= 58;
	if (label === "공시 호재") return reason.includes("공시") || change > 0;
	if (label === "뉴스 호재") return reason.includes("뉴스") || change > 0;
	if (label === "바닥권매집" || label === "박스권 하단")
		return Math.abs(change) <= 3;
	return score >= 50;
}

function loadThreshold(): ThresholdOption {
	if (typeof window === "undefined") return DEFAULT_THRESHOLD;

	const raw = window.localStorage.getItem(THRESHOLD_STORAGE_KEY);
	const parsed = raw ? Number(raw) : NaN;

	if (Number.isFinite(parsed) && parsed > 0) {
		return Math.round(parsed);
	}

	return DEFAULT_THRESHOLD;
}

function loadMarket(): MarketFilter {
	if (typeof window === "undefined") return DEFAULT_MARKET;

	const raw = window.localStorage.getItem(MARKET_STORAGE_KEY);

	if (raw && MARKET_OPTIONS.includes(raw as MarketFilter)) {
		return raw as MarketFilter;
	}

	return DEFAULT_MARKET;
}

function LoadingBox() {
	return (
		<div className="rounded-3xl border border-card-border bg-card p-8 text-center">
			<p className="break-keep text-sm font-bold leading-relaxed text-muted-foreground">
				조건검색 결과 불러오는 중...
			</p>
		</div>
	);
}

export default function ScannerPage() {
	const [, navigate] = useLocation();
	const [market, setMarket] = useState<MarketFilter>(DEFAULT_MARKET);
	const [selected, setSelected] = useState<string[]>(DEFAULT_SELECTED);
	const [helpOpen, setHelpOpen] = useState<string | null>(null);
	const [finderOpen, setFinderOpen] = useState(false);
	const [volumeThreshold, setVolumeThreshold] =
		useState<ThresholdOption>(DEFAULT_THRESHOLD);
	const [tradingValueThreshold, setTradingValueThreshold] =
		useState<ThresholdOption>(DEFAULT_THRESHOLD);
	const [volumeLookbackDays, setVolumeLookbackDays] = useState(5);
	const [tradingValueLookbackDays, setTradingValueLookbackDays] = useState(5);
	const [marketCapThreshold, setMarketCapThreshold] = useState<number>(
		MARKET_CAP_OPTIONS[0],
	);
	const [activePreset, setActivePreset] = useState<string | null>(null);
	const [thresholdOpen, setThresholdOpen] = useState<string | null>(null);
	const [autoSettings, setAutoSettings] = useState<AutoTradeSettings>(() =>
		loadAutoTradeSettings(),
	);
	const [autoRunning, setAutoRunning] = useState(false);
	const [autoMessage, setAutoMessage] = useState("");
	const [lastAutoRunKey, setLastAutoRunKey] = useState("");

	// localStorage에서 저장된 임계값·시장 복원.
	useEffect(() => {
		const savedThreshold = loadThreshold();
		setVolumeThreshold(savedThreshold);
		setTradingValueThreshold(savedThreshold);
		setMarket(loadMarket());
	}, []);

	const chooseMarket = (value: MarketFilter) => {
		setMarket(value);
		if (typeof window !== "undefined") {
			window.localStorage.setItem(MARKET_STORAGE_KEY, value);
		}
	};

	const selectedKey = selected.join("|");

	const usesVolume = selected.some((label) =>
		VOLUME_INDICATORS.includes(label),
	);
	const usesTradingValue = selected.some((label) =>
		TRADING_VALUE_INDICATORS.includes(label),
	);

	const scan = useQuery({
		queryKey: [
			"scan",
			market,
			selectedKey,
			volumeThreshold,
			tradingValueThreshold,
			volumeLookbackDays,
			tradingValueLookbackDays,
		],
		queryFn: () =>
			api.scan(selected, market, {
				volumeThreshold: usesVolume ? volumeThreshold : undefined,
				tradingValueThreshold: usesTradingValue
					? tradingValueThreshold
					: undefined,
				volumeLookbackDays: usesVolume ? volumeLookbackDays : undefined,
				tradingValueLookbackDays: usesTradingValue
					? tradingValueLookbackDays
					: undefined,
			} as any),
		enabled: selected.length > 0,
		refetchOnWindowFocus: false,
		refetchInterval: 90_000,
	});

	// 스캔 응답의 supportedIndicators를 우선 사용하고, 없으면 시드 목록을 사용한다.
	const availableIndicators = useMemo(() => {
		const supported = (
			scan.data as { supportedIndicators?: string[] } | undefined
		)?.supportedIndicators;
		const source = supported && supported.length ? supported : SEED_INDICATORS;

		return Array.from(new Set([...source, ...SEED_INDICATORS])).filter(
			(label) => label !== "거래량 급증",
		);
	}, [scan.data]);

	const cards = useMemo(() => {
		const response = scan.data as
			| { cards?: AnyObj[]; results?: AnyObj[] }
			| undefined;
		const raw = response?.cards ?? response?.results ?? [];

		if (!selected.length) return [];

		const filtered = raw.filter((card) => {
			const matched = matchedLabels(card);
			if (matched.length) {
				return selected.every((label) =>
					label === "시총"
						? (marketCapOf(card) ?? 0) >= marketCapThreshold
						: matched.includes(label),
				);
			}
			return selected.every((label) =>
				label === "시총"
					? (marketCapOf(card) ?? 0) >= marketCapThreshold
					: heuristicIndicatorMatch(
							card,
							label,
							volumeThreshold,
							tradingValueThreshold,
						),
			);
		});

		return sortByMatch(filtered, selected);
	}, [
		scan.data,
		selectedKey,
		volumeThreshold,
		tradingValueThreshold,
		marketCapThreshold,
	]);

	const autoCandidates = useMemo<AutoTradeCandidate[]>(() => {
		const generatedAt = new Date().toISOString();

		return cards.slice(0, 5).map((card, index) => {
			const matched = matchedLabels(card).filter((label) =>
				selected.includes(label),
			);
			const score = scoreOf(card);
			const changePercent =
				toNumber(card.changePercent) ?? toNumber(card.changeRate);
			const probability = estimateAutoTradeProbability({
				score,
				matchedCount: matched.length,
				selectedCount: selected.length,
				changePercent,
				breakoutProbability:
					toNumber(card.breakoutProbability) ??
					toNumber(card.probability) ??
					toNumber(card.winProbability),
			});
			const ticker = String(card.ticker ?? "").trim().toUpperCase();
			const name = displayStockName(
				ticker,
				String(card.name ?? ticker),
				cardMarket(card),
			);

			return {
				ticker,
				name,
				market: cardMarket(card),
				currency: cardCurrency(card),
				rank: index + 1,
				score,
				probability,
				price:
					toNumber(card.price) ??
					toNumber(card.currentPrice) ??
					toNumber(card.close),
				changePercent,
				reasons: (matched.length ? matched : selected).slice(0, 4),
				generatedAt,
			};
		});
	}, [cards, selectedKey]);

	const autoCandidatesKey = autoCandidates
		.map((candidate) => `${candidate.ticker}:${candidate.probability}`)
		.join("|");

	useEffect(() => {
		saveAutoTradeCandidates(autoCandidates);
	}, [autoCandidatesKey]);

	const updateAutoSettings = (patch: Partial<AutoTradeSettings>) => {
		setAutoSettings((current) =>
			saveAutoTradeSettings({
				...current,
				...patch,
			}),
		);
	};

	const runAutoTrading = async (automatic = false) => {
		if (autoRunning) return;

		setAutoRunning(true);
		setAutoMessage(automatic ? "자동매매 조건을 확인하는 중..." : "주문 조건을 확인하는 중...");

		try {
			const result = await executeAutoTradeCandidates(
				autoCandidates,
				autoSettings,
			);
			const successCount = (result.results ?? []).filter(
				(item) => item.ok && !item.skipped,
			).length;
			setAutoMessage(
				result.message ||
					(successCount > 0
						? `${successCount}개 종목 주문을 전송했습니다.`
						: "신규 주문 대상이 없습니다."),
			);
		} catch (error) {
			setAutoMessage(
				error instanceof Error ? error.message : "자동매매 주문에 실패했습니다.",
			);
		} finally {
			setAutoRunning(false);
		}
	};

	useEffect(() => {
		if (
			!autoSettings.enabled ||
			!autoSettings.liveTrading ||
			!autoCandidatesKey ||
			lastAutoRunKey === autoCandidatesKey
		) {
			return;
		}

		setLastAutoRunKey(autoCandidatesKey);
		void runAutoTrading(true);
	}, [
		autoSettings.enabled,
		autoSettings.liveTrading,
		autoSettings.maxRanks,
		autoSettings.minProbability,
		autoSettings.investmentPerTrade,
		autoCandidatesKey,
		lastAutoRunKey,
	]);

	useEffect(() => {
		if (
			!autoSettings.enabled ||
			!autoSettings.liveTrading ||
			!autoSettings.executionKey.trim()
		) {
			return;
		}

		const monitor = async () => {
			try {
				const result = await monitorAutoTradePositions(autoSettings);
				const sold = (result.results ?? []).filter(
					(item) => item.ok && !item.skipped && /매도/.test(item.message ?? ""),
				);
				if (sold.length) {
					setAutoMessage(result.message || `${sold.length}개 종목 자동매도를 전송했습니다.`);
				}
			} catch (error) {
				console.error("auto trade monitor error:", error);
			}
		};

		void monitor();
		const id = window.setInterval(() => void monitor(), 30_000);
		return () => window.clearInterval(id);
	}, [
		autoSettings.enabled,
		autoSettings.liveTrading,
		autoSettings.executionKey,
	]);

	const toggleIndicator = (label: string) => {
		setSelected((current) =>
			current.includes(label)
				? current.filter((item) => item !== label)
				: [...current, label],
		);
	};

	const removeIndicator = (label: string) => {
		setSelected((current) => current.filter((item) => item !== label));
		setHelpOpen((current) => (current === label ? null : current));
		setThresholdOpen((current) => (current === label ? null : current));
	};

	const chooseIndicatorThreshold = (label: string, value: ThresholdOption) => {
		if (TRADING_VALUE_INDICATORS.includes(label)) {
			setTradingValueThreshold(value);
		} else {
			setVolumeThreshold(value);
		}
		if (typeof window !== "undefined") {
			window.localStorage.setItem(THRESHOLD_STORAGE_KEY, String(value));
		}
		setThresholdOpen(null);
	};

	const applyPreset = (preset: (typeof STRATEGY_PRESETS)[number]) => {
		setSelected([...preset.indicators]);
		setActivePreset(preset.key);
		setHelpOpen(null);
		setThresholdOpen(null);
	};

	const toggleHelp = (event: MouseEvent<HTMLButtonElement>, label: string) => {
		event.stopPropagation();
		setHelpOpen((current) => (current === label ? null : label));
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
			<header className="sticky top-0 z-20 border-b border-card-border bg-background/90 px-4 pb-3 pt-4 glass">
				<div className="mb-3 flex items-center justify-between gap-3">
					<div>
						<h1 className="text-xl font-extrabold">조건검색기</h1>

						<p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
							지표를 조합하여 검색합니다.
						</p>
					</div>

					<button
						type="button"
						onClick={() => void scan.refetch()}
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"
					>
						<RefreshCw
							className={cn("h-4 w-4", scan.isFetching && "animate-spin")}
						/>
					</button>
				</div>

				<div className="grid grid-cols-2 gap-2">
					{MARKET_OPTIONS.map((item) => (
						<button
							key={item}
							type="button"
							onClick={() => chooseMarket(item)}
							className={cn(
								"rounded-xl border px-3 py-2 text-sm font-bold",
								market === item
									? "border-primary bg-primary text-primary-foreground"
									: "border-card-border bg-card text-muted-foreground",
							)}
						>
							{item === "KR" ? "국내" : "해외"}
						</button>
					))}
				</div>
			</header>

			<main className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 pb-24">
				<section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
					<div className="mb-3">
						<h2 className="text-sm font-extrabold">투자 기간별 추천 조건</h2>
					</div>
					<div className="grid grid-cols-3 gap-2">
						{STRATEGY_PRESETS.map((preset) => (
							<button
								key={preset.key}
								type="button"
								onClick={() => applyPreset(preset)}
								className={cn(
									"rounded-2xl border px-2 py-2.5 text-center",
									activePreset === preset.key
										? "border-primary bg-primary/10 text-primary"
										: "border-card-border bg-background text-foreground",
								)}
							>
								<span className="block text-sm font-extrabold">
									{preset.label}
								</span>
							</button>
						))}
					</div>
				</section>

				<section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
					<div className="mb-3 flex items-center justify-between gap-2">
						<h2 className="text-sm font-extrabold">지표</h2>

						<button
							type="button"
							onClick={() => setFinderOpen(true)}
							className="flex items-center gap-1 rounded-full border border-primary bg-primary/10 px-3 py-1.5 text-xs font-extrabold text-primary"
						>
							<Search className="h-3.5 w-3.5" />
							지표 찾기
						</button>
					</div>

					{selected.length === 0 ? (
						<button
							type="button"
							onClick={() => setFinderOpen(true)}
							className="flex w-full items-center justify-center gap-1 rounded-2xl border border-dashed border-card-border bg-background px-3 py-4 text-xs font-bold text-muted-foreground"
						>
							<Plus className="h-4 w-4" />
							지표 찾기에서 조건을 추가하세요.
						</button>
					) : (
						<div className="space-y-2">
							{selected.map((label) => {
								const helpActive = helpOpen === label;
								const help = getHelp(label);

								return (
									<div
										key={label}
										className="rounded-2xl border border-primary bg-primary/10 p-2"
									>
										<div className="grid grid-cols-[1fr_28px_28px] items-center gap-1">
											<button
												type="button"
												onClick={() => {
													const hasThreshold =
														VOLUME_INDICATORS.includes(label) ||
														TRADING_VALUE_INDICATORS.includes(label) ||
														MARKET_CAP_INDICATORS.includes(label);
													setHelpOpen(label);
													setThresholdOpen(hasThreshold ? label : null);
												}}
												className="min-w-0 break-keep text-left text-xs font-extrabold leading-relaxed text-primary"
											>
												{label}
											</button>

											<button
												type="button"
												onClick={(event) => toggleHelp(event, label)}
												className={cn(
													"flex h-7 w-7 items-center justify-center rounded-full border text-xs font-extrabold",
													helpActive
														? "border-warning bg-warning/10 text-warning"
														: "border-card-border bg-secondary text-muted-foreground",
												)}
												title={`${label} 설명`}
											>
												<Star
													className="h-3.5 w-3.5"
													fill={helpActive ? "currentColor" : "none"}
												/>
											</button>

											<button
												type="button"
												onClick={() => removeIndicator(label)}
												className="flex h-7 w-7 items-center justify-center rounded-full border border-card-border bg-secondary text-muted-foreground"
												title={`${label} 제거`}
											>
												<X className="h-3.5 w-3.5" />
											</button>
										</div>

										{false &&
											thresholdOpen === label &&
											(VOLUME_INDICATORS.includes(label) ||
												TRADING_VALUE_INDICATORS.includes(label)) && (
												<div className="mt-2 rounded-xl border border-card-border bg-card p-2">
													<p className="mb-2 text-[11px] font-extrabold text-foreground">
														{label} 기준 선택
													</p>
													<div className="grid grid-cols-3 gap-2">
														{THRESHOLD_OPTIONS.map((value) => {
															const currentValue =
																TRADING_VALUE_INDICATORS.includes(label)
																	? tradingValueThreshold
																	: volumeThreshold;
															return (
																<button
																	key={value}
																	type="button"
																	onClick={() =>
																		chooseIndicatorThreshold(label, value)
																	}
																	className={cn(
																		"rounded-xl border px-2 py-2 text-xs font-extrabold",
																		currentValue === value
																			? "border-primary bg-primary text-primary-foreground"
																			: "border-card-border bg-background text-muted-foreground",
																	)}
																>
																	{value}% 이상
																</button>
															);
														})}
													</div>
												</div>
											)}

										{false && helpActive && (
											<div className="mt-2 rounded-xl border border-card-border bg-card p-2 shadow-sm">
												<div className="mb-1 flex items-center gap-1 text-primary">
													<HelpCircle className="h-3.5 w-3.5" />

													<p className="text-[11px] font-extrabold">설명</p>
												</div>

												<p className="break-keep text-[11px] leading-relaxed text-muted-foreground">
													{help.why}
												</p>

												<p className="mt-1 break-keep text-[11px] leading-relaxed text-muted-foreground">
													{help.watch}
												</p>
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</section>

				<section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<h2 className="text-sm font-extrabold">자동매매 1~5순위</h2>
							<p className="mt-1 break-keep text-[11px] font-semibold leading-5 text-muted-foreground">
								현재 선택한 지표의 일치도와 AI 점수를 합산해 순위와 조건 충족 확률을 표시합니다.
							</p>
						</div>
						<button
							type="button"
							onClick={() =>
								updateAutoSettings({ enabled: !autoSettings.enabled })
							}
							className={cn(
								"shrink-0 rounded-full border px-3 py-1.5 text-xs font-extrabold",
								autoSettings.enabled
									? "border-primary bg-primary text-primary-foreground"
									: "border-card-border bg-background text-muted-foreground",
							)}
						>
							{autoSettings.enabled ? "신호 켜짐" : "신호 꺼짐"}
						</button>
					</div>

					<div className="mt-3 grid grid-cols-2 gap-2">
						<label className="rounded-2xl border border-card-border bg-background p-3">
							<span className="block text-[10px] font-extrabold text-muted-foreground">
								1종목 주문금액
							</span>
							<input
								type="number"
								min={1}
								step={10000}
								inputMode="numeric"
								value={autoSettings.investmentPerTrade}
								onChange={(event) =>
									updateAutoSettings({
										investmentPerTrade: Math.max(1, Number(event.target.value) || 1),
									})
								}
								className="mt-1 w-full bg-transparent text-sm font-extrabold outline-none"
							/>
						</label>
						<label className="rounded-2xl border border-card-border bg-background p-3">
							<span className="block text-[10px] font-extrabold text-muted-foreground">
								최소 확률
							</span>
							<div className="mt-1 flex items-center gap-1">
								<input
									type="number"
									min={1}
									max={99}
									value={autoSettings.minProbability}
									onChange={(event) =>
										updateAutoSettings({
											minProbability: Number(event.target.value) || 1,
										})
									}
									className="min-w-0 flex-1 bg-transparent text-sm font-extrabold outline-none"
								/>
								<span className="text-xs font-extrabold">%</span>
							</div>
						</label>
						<label className="rounded-2xl border border-card-border bg-background p-3">
							<span className="block text-[10px] font-extrabold text-muted-foreground">
								손절 기준
							</span>
							<div className="mt-1 flex items-center gap-1">
								<input
									type="number"
									min={0.1}
									step={0.1}
									value={autoSettings.stopLossPercent}
									onChange={(event) =>
										updateAutoSettings({
											stopLossPercent: Number(event.target.value) || 0.1,
										})
									}
									className="min-w-0 flex-1 bg-transparent text-sm font-extrabold outline-none"
								/>
								<span className="text-xs font-extrabold">%</span>
							</div>
						</label>
						<label className="rounded-2xl border border-card-border bg-background p-3">
							<span className="block text-[10px] font-extrabold text-muted-foreground">
								목표 수익
							</span>
							<div className="mt-1 flex items-center gap-1">
								<input
									type="number"
									min={0.1}
									step={0.1}
									value={autoSettings.takeProfitPercent}
									onChange={(event) =>
										updateAutoSettings({
											takeProfitPercent: Number(event.target.value) || 0.1,
										})
									}
									className="min-w-0 flex-1 bg-transparent text-sm font-extrabold outline-none"
								/>
								<span className="text-xs font-extrabold">%</span>
							</div>
						</label>
					</div>

					<label className="mt-2 block rounded-2xl border border-card-border bg-background p-3">
						<span className="block text-[10px] font-extrabold text-muted-foreground">
							자동매매 실행키
						</span>
						<input
							type="password"
							value={autoSettings.executionKey}
							onChange={(event) =>
								updateAutoSettings({ executionKey: event.target.value })
							}
							placeholder="설정한 실행키 입력"
							autoComplete="off"
							className="mt-1 w-full bg-transparent text-sm font-bold outline-none"
						/>
					</label>

					<div className="mt-2 grid grid-cols-2 gap-2">
						<button
							type="button"
							onClick={() =>
								updateAutoSettings({ liveTrading: !autoSettings.liveTrading })
							}
							className={cn(
								"rounded-2xl border px-3 py-3 text-xs font-extrabold",
								autoSettings.liveTrading
									? "border-destructive bg-destructive/10 text-destructive"
									: "border-card-border bg-background text-muted-foreground",
							)}
						>
							{autoSettings.liveTrading ? "실제주문 켜짐" : "실제주문 꺼짐"}
						</button>
						<button
							type="button"
							onClick={() => void runAutoTrading(false)}
							disabled={autoRunning || autoCandidates.length === 0}
							className="rounded-2xl bg-primary px-3 py-3 text-xs font-extrabold text-primary-foreground disabled:opacity-50"
						>
							{autoRunning ? "확인 중..." : "조건 주문 실행"}
						</button>
					</div>

					{autoMessage && (
						<p className="mt-2 break-keep rounded-2xl bg-secondary/70 px-3 py-2 text-[11px] font-bold leading-5 text-muted-foreground">
							{autoMessage}
						</p>
					)}

					<div className="mt-3 space-y-2">
						{autoCandidates.length === 0 ? (
							<p className="rounded-2xl bg-secondary/70 px-3 py-4 text-center text-xs font-bold text-muted-foreground">
								조건검색 결과가 나오면 1~5순위를 표시합니다.
							</p>
						) : (
							autoCandidates.map((candidate) => (
								<button
									key={`${candidate.ticker}:${candidate.rank}`}
									type="button"
									onClick={() =>
										navigate(
											`/stock/${candidate.ticker}?back=${encodeURIComponent("/scanner")}`,
										)
									}
									className="w-full rounded-2xl border border-card-border bg-background p-3 text-left"
								>
									<div className="flex items-start justify-between gap-3">
										<div className="min-w-0">
											<p className="truncate text-sm font-extrabold">
												{candidate.rank}위 · {candidate.name}
											</p>
											<p className="mt-1 truncate text-[11px] font-bold text-muted-foreground">
												{candidate.reasons.join(" · ") || "AI 점수 기준"}
											</p>
										</div>
										<div className="shrink-0 text-right">
											<p className="text-sm font-black text-primary">
												{candidate.probability}%
											</p>
											<p className="mt-1 text-[10px] font-bold text-muted-foreground">
												조건 충족 확률
											</p>
										</div>
									</div>
								</button>
							))
						)}
					</div>
				</section>

				{selected.length === 0 && (
					<div className="rounded-3xl border border-card-border bg-card p-6 text-center">
						<p className="break-keep text-sm font-bold leading-relaxed">
							지표를 하나 이상 선택하세요.
						</p>
					</div>
				)}

				{scan.isLoading && <LoadingBox />}

				{scan.isError && (
					<div className="rounded-3xl border border-card-border bg-card p-6 text-center">
						<p className="break-keep text-sm font-bold leading-relaxed text-destructive">
							조건검색 결과를 불러오지 못했습니다.
						</p>

						<button
							type="button"
							onClick={() => void scan.refetch()}
							className="mt-3 rounded-full bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"
						>
							다시 시도
						</button>
					</div>
				)}

				{scan.data && cards.length === 0 && (
					<div className="rounded-3xl border border-card-border bg-card p-6 text-center">
						<p className="break-keep text-sm font-bold leading-relaxed">
							조건에 맞는 종목이 없습니다.
						</p>

						<p className="mt-2 break-keep text-xs leading-relaxed text-muted-foreground">
							지표를 줄이거나 시장을 바꿔 보세요.
						</p>
					</div>
				)}

				<div className="space-y-2">
					{cards.map((card) => (
						<ScannerCard
							key={`${String(card.market)}:${String(card.ticker)}`}
							card={card}
							selected={selected}
							onOpen={() =>
								navigate(
									`/stock/${String(card.ticker)}?back=${encodeURIComponent(
										"/scanner",
									)}`,
								)
							}
						/>
					))}
				</div>
			</main>

			{helpOpen && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-5 backdrop-blur-sm"
					onClick={() => {
						setHelpOpen(null);
						setThresholdOpen(null);
					}}
				>
					<div
						role="dialog"
						aria-modal="true"
						aria-label={`${helpOpen} 설명`}
						onClick={(event) => event.stopPropagation()}
						className="w-full max-w-[360px] rounded-3xl border border-card-border bg-card p-5 shadow-2xl"
					>
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<p className="text-xs font-extrabold text-primary">
									기술지표 안내
								</p>
								<h2 className="mt-1 break-keep text-lg font-black">
									{helpOpen}
								</h2>
							</div>
							<button
								type="button"
								aria-label="설명 닫기"
								onClick={() => {
									setHelpOpen(null);
									setThresholdOpen(null);
								}}
								className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground"
							>
								<X className="h-4 w-4" />
							</button>
						</div>
						<div className="mt-4 space-y-3">
							<div className="rounded-2xl bg-secondary/70 p-3">
								<p className="text-xs font-extrabold">이 지표는 무엇인가요?</p>
								<p className="mt-1 break-keep text-sm leading-relaxed text-muted-foreground">
									{getHelp(helpOpen).why}
								</p>
							</div>
							<div className="rounded-2xl bg-primary/10 p-3">
								<p className="text-xs font-extrabold text-primary">
									언제 쓰면 좋나요?
								</p>
								<p className="mt-1 break-keep text-sm leading-relaxed text-muted-foreground">
									{getHelp(helpOpen).watch}
								</p>
							</div>
							{thresholdOpen === helpOpen && (
								<div>
									<p className="mb-2 text-xs font-extrabold">
										{helpOpen === "시총"
											? "시가총액 기준 선택"
											: "증가 기준 선택"}
									</p>
									{helpOpen === "시총" ? (
										<div className="grid grid-cols-3 gap-2">
											{MARKET_CAP_OPTIONS.map((value, index) => (
												<button
													key={value}
													type="button"
													onClick={() => {
														setMarketCapThreshold(value);
														setThresholdOpen(null);
														setHelpOpen(null);
													}}
													className={cn(
														"rounded-xl border px-2 py-2 text-xs font-extrabold",
														marketCapThreshold === value
															? "border-primary bg-primary text-primary-foreground"
															: "border-card-border bg-background",
													)}
												>
													{[10, 50, 100][index]}억 이상
												</button>
											))}
										</div>
									) : (
										(() => {
											const isTradingValue =
												TRADING_VALUE_INDICATORS.includes(helpOpen);
											const currentValue = isTradingValue
												? tradingValueThreshold
												: volumeThreshold;
											const currentDays = isTradingValue
												? tradingValueLookbackDays
												: volumeLookbackDays;
											const setCurrentValue = isTradingValue
												? setTradingValueThreshold
												: setVolumeThreshold;
											const setCurrentDays = isTradingValue
												? setTradingValueLookbackDays
												: setVolumeLookbackDays;
											return (
												<div className="space-y-4">
													<label className="block">
														<span className="mb-2 block text-xs font-extrabold">
															증가율 직접 입력
														</span>
														<div className="flex items-center gap-2 rounded-2xl border border-card-border bg-background px-3 py-2">
															<input
																type="number"
																min={1}
																step={1}
																inputMode="numeric"
																value={currentValue}
																onChange={(event) => {
																	const value = Math.max(
																		1,
																		Number(event.target.value) || 1,
																	);
																	setCurrentValue(value);
																	window.localStorage.setItem(
																		THRESHOLD_STORAGE_KEY,
																		String(value),
																	);
																}}
																className="min-w-0 flex-1 bg-transparent text-base font-extrabold outline-none"
																aria-label="증가율 직접 입력"
															/>
															<span className="text-sm font-extrabold text-primary">
																% 이상
															</span>
														</div>
													</label>
													<div>
														<p className="mb-2 text-xs font-extrabold">
															비교 거래일
														</p>
														<div className="grid grid-cols-3 gap-2">
															{LOOKBACK_OPTIONS.map((option) => (
																<button
																	key={option.value}
																	type="button"
																	onClick={() => setCurrentDays(option.value)}
																	className={cn(
																		"rounded-xl border px-2 py-2 text-xs font-extrabold",
																		currentDays === option.value
																			? "border-primary bg-primary text-primary-foreground"
																			: "border-card-border bg-background",
																	)}
																>
																	{option.label}
																</button>
															))}
														</div>
														<label className="mt-2 flex items-center gap-2 rounded-2xl border border-card-border bg-background px-3 py-2">
															<span className="shrink-0 text-xs font-bold text-muted-foreground">
																직접 입력
															</span>
															<input
																type="number"
																min={1}
																max={250}
																step={1}
																inputMode="numeric"
																value={currentDays}
																onChange={(event) =>
																	setCurrentDays(
																		Math.min(
																			250,
																			Math.max(
																				1,
																				Number(event.target.value) || 1,
																			),
																		),
																	)
																}
																className="min-w-0 flex-1 bg-transparent text-right text-sm font-extrabold outline-none"
																aria-label="비교 거래일 직접 입력"
															/>
															<span className="shrink-0 text-xs font-bold">
																거래일 전
															</span>
														</label>
													</div>
													<button
														type="button"
														onClick={() => {
															setThresholdOpen(null);
															setHelpOpen(null);
														}}
														className="w-full rounded-xl bg-primary px-3 py-2.5 text-sm font-extrabold text-primary-foreground"
													>
														적용
													</button>
												</div>
											);
										})()
									)}
								</div>
							)}
						</div>
					</div>
				</div>
			)}

			{finderOpen && (
				<IndicatorFinder
					indicators={availableIndicators}
					selected={selected}
					onToggle={toggleIndicator}
					onClose={() => setFinderOpen(false)}
				/>
			)}

			<BottomNav />
		</div>
	);
}

function IndicatorFinder({
	indicators,
	selected,
	onToggle,
	onClose,
}: {
	indicators: string[];
	selected: string[];
	onToggle: (label: string) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");

	const filtered = useMemo(() => {
		const q = query.trim();

		if (!q) return indicators;

		return indicators.filter((label) => label.includes(q));
	}, [indicators, query]);

	return (
		<div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/70">
			<button
				type="button"
				aria-label="닫기"
				onClick={onClose}
				className="flex-1"
			/>

			<div className="max-h-[85dvh] rounded-t-3xl border border-card-border bg-card p-4 shadow-2xl">
				<div className="mb-3 flex items-center justify-between gap-3">
					<h2 className="text-lg font-extrabold">지표 찾기</h2>

					<button
						type="button"
						onClick={onClose}
						className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="mb-3 flex items-center gap-2 rounded-2xl border border-card-border bg-card px-3 py-2">
					<Search className="h-4 w-4 shrink-0 text-muted-foreground" />

					<input
						type="text"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="지표 이름으로 검색"
						className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none placeholder:text-muted-foreground"
					/>

					{query && (
						<button
							type="button"
							onClick={() => setQuery("")}
							className="shrink-0 text-muted-foreground"
							aria-label="검색어 지우기"
						>
							<X className="h-4 w-4" />
						</button>
					)}
				</div>

				<p className="mb-2 break-keep text-[11px] leading-relaxed text-muted-foreground">
					선택한 지표 {selected.length}개 · 여러 지표를 고르면 모두 만족하는
					종목만 남습니다.
				</p>

				<div className="max-h-[52dvh] space-y-2 overflow-y-auto pb-2">
					{filtered.length === 0 ? (
						<p className="break-keep py-6 text-center text-sm font-bold leading-relaxed text-muted-foreground">
							검색 결과가 없습니다.
						</p>
					) : (
						filtered.map((label) => {
							const active = selected.includes(label);
							const help = getHelp(label);

							return (
								<button
									key={label}
									type="button"
									onClick={() => onToggle(label)}
									className={cn(
										"flex w-full items-start gap-2 rounded-2xl border p-3 text-left",
										active
											? "border-primary bg-primary/10"
											: "border-card-border bg-card",
									)}
								>
									<span
										className={cn(
											"mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-extrabold",
											active
												? "border-primary bg-primary text-primary-foreground"
												: "border-card-border text-muted-foreground",
										)}
									>
										{active ? "✓" : "+"}
									</span>

									<span className="min-w-0 flex-1">
										<span
											className={cn(
												"block break-keep text-sm font-extrabold leading-relaxed",
												active ? "text-primary" : "text-foreground",
											)}
										>
											{label}
										</span>

										<span className="mt-1 block break-keep text-[11px] leading-relaxed text-muted-foreground">
											{help.why}
										</span>
									</span>
								</button>
							);
						})
					)}
				</div>

				<button
					type="button"
					onClick={onClose}
					className="mt-3 w-full rounded-full bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground"
				>
					완료
				</button>
			</div>
		</div>
	);
}

function ScannerCard({
	card,
	selected,
	onOpen,
}: {
	card: AnyObj;
	selected: string[];
	onOpen: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const market = cardMarket(card);
	const currency = cardCurrency(card);
	const name = displayStockName(
		String(card.ticker),
		String(card.name ?? card.ticker),
		market,
	);
	const changePercent = toNumber(card.changePercent) ?? 0;
	const positive = changePercent >= 0;
	const aiScore = scoreOf(card);

	const matched = matchedLabels(card);
	const matchedSelected = selected.filter((label) =>
		matched.includes(label),
	).length;

	const classification = classifyStock({
		...card,
		aiScore,
		score: aiScore,
		changePercent: toNumber(card.changePercent),
		reasons: matched,
	});

	return (
		<article
			role="button"
			tabIndex={0}
			aria-expanded={expanded}
			onClick={() => setExpanded((current) => !current)}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					setExpanded((current) => !current);
				}
			}}
			className="cursor-pointer rounded-3xl border border-card-border bg-card p-4 shadow-sm transition active:scale-[0.99]"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="break-keep text-base font-extrabold leading-relaxed">
						{name}
					</h3>
					{expanded && (
						<p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
							{market === "US"
								? `티커 ${String(card.ticker)}`
								: String(card.ticker)}
						</p>
					)}{" "}
				</div>

				<div className="flex shrink-0 items-center gap-2">
					{expanded && (
						<div className="rounded-full bg-primary/10 px-2.5 py-1 text-center">
							<span className="block text-[10px] font-bold text-primary">
								AI 점수
							</span>
							<span className="block text-sm font-extrabold text-primary">
								{aiScore}
							</span>
						</div>
					)}

					<ChevronRight
						className={cn(
							"h-4 w-4 text-muted-foreground transition-transform",
							expanded && "rotate-90",
						)}
					/>
				</div>
			</div>

			{expanded && (
				<>
					<div className="mt-3 grid grid-cols-3 gap-2 text-center">
						<InfoBox
							label="현재가"
							value={formatAppPrice(toNumber(card.price), currency)}
						/>

						<InfoBox
							label="등락률"
							value={formatAppPercent(toNumber(card.changePercent))}
							tone={positive ? "positive" : "negative"}
							icon={
								positive ? (
									<TrendingUp className="h-3 w-3" />
								) : (
									<TrendingDown className="h-3 w-3" />
								)
							}
						/>

						<InfoBox
							label="돌파확률"
							value={`${toNumber(card.breakoutProbability) ?? 0}%`}
						/>
					</div>

					<div
						className={cn(
							"mt-3 rounded-2xl border px-3 py-2 text-center text-xs font-extrabold break-keep leading-relaxed",
							stockClassBadgeClass(
								(card.grade as StockGrade | undefined)?.label ??
									classification.label,
							),
						)}
					>
						{(card.grade as StockGrade | undefined)?.label ??
							classification.label}{" "}
						·{" "}
						{(card.grade as StockGrade | undefined)?.reason ??
							classification.reason}
					</div>

					<div className="mt-3 flex flex-wrap justify-center gap-1.5">
						{matched.map((item) => (
							<span
								key={item}
								className="break-keep rounded-full bg-primary/10 px-2 py-1 text-[11px] font-bold leading-relaxed text-primary"
							>
								{item}
							</span>
						))}
					</div>

					<div className="mt-3 grid grid-cols-1 gap-2 text-xs">
						<PlanBlock
							title="진입가"
							items={Array.isArray(card.entry) ? (card.entry as string[]) : []}
							currency={currency}
							desc="현재 조건이 유지될 때 분할 접근하는 기준입니다."
						/>

						<PlanBlock
							title="손절가"
							items={Array.isArray(card.stop) ? (card.stop as string[]) : []}
							currency={currency}
							desc="추세가 깨졌다고 보는 방어 기준입니다."
						/>
					</div>

					<p className="mt-3 break-keep text-center text-xs font-medium leading-relaxed text-muted-foreground">
						기대기간: {String(card.expectedPeriod || "단기 추세 확인 필요")} ·
						조건 일치 {matchedSelected}/{selected.length}
					</p>
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							onOpen();
						}}
						className="mt-3 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground"
					>
						종목 상세 보기
					</button>
				</>
			)}
		</article>
	);
}

function InfoBox({
	label,
	value,
	tone,
	icon,
}: {
	label: string;
	value: string;
	tone?: "positive" | "negative";
	icon?: ReactNode;
}) {
	return (
		<div className="rounded-2xl bg-secondary/70 p-2">
			<p className="break-keep text-[11px] leading-relaxed text-muted-foreground">
				{label}
			</p>

			<p
				className={cn(
					"mt-1 flex items-center justify-center gap-1 break-keep text-sm font-extrabold leading-relaxed",
					tone === "positive" && "text-positive",
					tone === "negative" && "text-destructive",
				)}
			>
				{icon}
				{value}
			</p>
		</div>
	);
}

function PlanBlock({
	title,
	items,
	currency,
	desc,
}: {
	title: string;
	items: string[];
	currency: string;
	desc: string;
}) {
	return (
		<div className="rounded-2xl bg-secondary/70 p-3 text-left">
			<p className="text-sm font-extrabold">{title}</p>

			<div className="mt-2 space-y-1">
				{items.length ? (
					items.map((item, index) => (
						<p
							key={`${title}:${item}:${index}`}
							className="break-keep rounded-xl bg-background/70 px-2 py-1.5 text-[11px] font-bold leading-relaxed text-muted-foreground"
						>
							{index + 1}. {normalizePlanText(item, currency)}
						</p>
					))
				) : (
					<p className="break-keep text-xs leading-relaxed text-muted-foreground">
						데이터 확인 필요
					</p>
				)}
			</div>

			<p className="mt-2 break-keep text-[11px] leading-relaxed text-muted-foreground">
				{desc}
			</p>
		</div>
	);
}
