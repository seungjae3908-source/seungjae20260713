export type StudyMarkerStrategy =
	| "latest"
	| "highest-volume"
	| "breakout"
	| "recent-low"
	| "recent-high";

export interface StudyChartFocus {
	id: string;
	title: string;
	summary: string;
	markerText: string;
	markerStrategy: StudyMarkerStrategy;
	preferredIndicator?:
		| "rsi"
		| "macd"
		| "bollinger"
		| "volume"
		| "moving-average";
}

const STUDY_FOCUS: Record<string, StudyChartFocus> = {
	candlestick: {
		id: "candlestick",
		title: "캔들 읽기",
		summary:
			"몸통은 시가와 종가, 꼬리는 장중 고가와 저가입니다. 종가가 몸통 어느 쪽에 있는지 확인하세요.",
		markerText: "캔들 몸통·꼬리 확인",
		markerStrategy: "latest",
	},
	trend: {
		id: "trend",
		title: "추세 확인",
		summary:
			"고점과 저점이 함께 높아지면 상승 추세, 함께 낮아지면 하락 추세로 봅니다.",
		markerText: "최근 추세 구간",
		markerStrategy: "latest",
		preferredIndicator: "moving-average",
	},
	bollinger: {
		id: "bollinger",
		title: "볼린저밴드",
		summary:
			"밴드 폭이 좁아진 뒤 거래량과 함께 상단을 돌파하는지, 돌파 후 상단 위에서 유지되는지 확인하세요.",
		markerText: "밴드 돌파 확인",
		markerStrategy: "breakout",
		preferredIndicator: "bollinger",
	},
	rsi: {
		id: "rsi",
		title: "RSI",
		summary:
			"RSI 30 이하에서 되돌림이 나오는지, 가격이 이전 저점을 지키는지를 함께 확인해야 합니다.",
		markerText: "RSI 반등 확인",
		markerStrategy: "recent-low",
		preferredIndicator: "rsi",
	},
	macd: {
		id: "macd",
		title: "MACD",
		summary:
			"MACD선이 시그널선을 상향 돌파한 뒤 막대가 커지는지 확인하면 추세 전환 강도를 볼 수 있습니다.",
		markerText: "MACD 전환 구간",
		markerStrategy: "latest",
		preferredIndicator: "macd",
	},
	"moving-average": {
		id: "moving-average",
		title: "이동평균선",
		summary:
			"주가가 20일선을 회복하고 그 위에서 유지되는지, 단기선과 중기선의 방향이 같은지 확인하세요.",
		markerText: "이평선 위치 확인",
		markerStrategy: "latest",
		preferredIndicator: "moving-average",
	},
	volume: {
		id: "volume",
		title: "거래량",
		summary:
			"최근 가장 큰 거래량이 나온 캔들의 종가 위치와 윗꼬리 여부를 확인하세요.",
		markerText: "거래량 최대 구간",
		markerStrategy: "highest-volume",
		preferredIndicator: "volume",
	},
	"golden-cross": {
		id: "golden-cross",
		title: "골든크로스",
		summary:
			"단기 이동평균선이 중기 이동평균선을 위로 넘은 뒤 가격이 두 선 위에서 유지되는지 확인하세요.",
		markerText: "골든크로스 확인",
		markerStrategy: "latest",
		preferredIndicator: "moving-average",
	},
	breakout: {
		id: "breakout",
		title: "캔들 돌파",
		summary:
			"최근 고점을 거래량과 함께 넘고 종가가 저항선 위에서 마감되는지 확인하세요.",
		markerText: "저항 돌파 구간",
		markerStrategy: "breakout",
		preferredIndicator: "volume",
	},
	pullback: {
		id: "pullback",
		title: "눌림목",
		summary:
			"돌파 뒤 조정에서 거래량이 감소하고 이전 저항선이나 20일선에서 다시 반등하는지 확인하세요.",
		markerText: "눌림 지지 확인",
		markerStrategy: "recent-low",
		preferredIndicator: "moving-average",
	},
	"support-resistance": {
		id: "support-resistance",
		title: "지지선·저항선",
		summary:
			"최근 반복해서 반등한 저점과 반복해서 막힌 고점을 수평 가격대로 확인하세요.",
		markerText: "지지·저항 구간",
		markerStrategy: "recent-low",
	},
};

export function getStudyChartFocus(id: string | null | undefined) {
	if (!id) return null;

	return STUDY_FOCUS[id] ?? {
		id,
		title: "실제 차트 학습",
		summary:
			"선택한 공부 항목을 실제 가격 흐름과 함께 확인하고 단일 지표만으로 매매하지 마세요.",
		markerText: "학습 확인 구간",
		markerStrategy: "latest" as const,
	};
}
