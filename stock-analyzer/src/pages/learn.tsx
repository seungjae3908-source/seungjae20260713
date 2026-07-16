import {
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronDown,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { cn } from '@/lib/utils';
import { api, type Candle } from '@/lib/api';

// ── 공부 페이지 ──────────────────────────────────────────────
// 교육 목적 전용. 실제 매수·매도 권유가 아니며, 데이터가 없으면
// '정보 없음' / '데이터 부족' / '제공 불가'로 표기한다. 실제 차트 예시는
// api.chart 로 불러온 실데이터에서만 사례를 탐지한다.

type StudyGroup = '캔들' | '차트 기초' | '보조지표';

// 실제 차트에서 사례를 탐지할 때 사용하는 이벤트 종류
type DetectKind =
  | 'bullish' // 양봉
  | 'bearish' // 음봉
  | 'doji' // 도지
  | 'hammer' // 망치형
  | 'invertedHammer' // 역망치형
  | 'longBullish' // 장대양봉
  | 'longBearish' // 장대음봉
  | 'bullishEngulfing' // 상승장악형
  | 'bearishEngulfing' // 하락장악형
  | 'morningStar' // 샛별형
  | 'eveningStar' // 석별형
  | 'support' // 지지선 반등
  | 'resistance' // 저항선 돌파
  | 'trendUp' // 추세선(상승)
  | 'box' // 박스권
  | 'breakout' // 돌파
  | 'gap' // 갭
  | 'volume' // 거래량 급증
  | 'goldenCross' // 골든크로스
  | 'deadCross' // 데드크로스
  | 'rsiOversold' // RSI 과매도
  | 'rsiOverbought' // RSI 과열
  | 'macdCross' // MACD 골든크로스
  | 'bollingerBreak' // 볼린저밴드 상단 돌파
  | 'atrSpike' // ATR 급등(변동성 확대)
  | 'stochOversold' // 스토캐스틱 과매도
  | 'obvUp'; // OBV 상승 다이버전스

interface StudyTopic {
  id: string;
  group: StudyGroup;
  title: string;
  short: string;
  concept: string; // 개념 설명
  condition: string; // 발생 조건
  interpretation: string; // 일반적인 해석
  buySignal: string; // 매수 신호로 볼 수 있는 경우
  sellSignal: string; // 매도 또는 위험 신호
  mistake: string; // 잘못 해석하기 쉬운 점
  related: string; // 함께 확인하면 좋은 다른 지표
  detect: DetectKind; // 실제 차트 예시 탐지 종류
}

const DEFAULT_TICKER = '005930';
const DEFAULT_TICKER_NAME = '삼성전자';
const NOTICE = '교육 목적이며 매수·매도 권유가 아닙니다.';

const TOPICS: StudyTopic[] = [
  // ── 캔들 ──────────────────────────────────────────────
  {
    id: 'bullish',
    group: '캔들',
    title: '양봉',
    short: '종가가 시가보다 높게 끝난 상승 캔들',
    concept:
      '양봉은 하루(또는 한 봉) 동안 종가가 시가보다 높게 끝난 캔들입니다. 몸통은 시가와 종가 사이이며, 매수세가 매도세보다 우위였다는 뜻입니다.',
    condition: '종가 > 시가. 몸통이 위쪽 방향으로 형성되어 상승 마감된 경우입니다.',
    interpretation: '해당 구간에서 매수세가 우위였음을 보여줍니다. 연속된 양봉은 단기 상승 흐름을 시사합니다.',
    buySignal: '지지선 부근이나 거래량 증가와 함께 양봉이 나오면 반등·상승 시작 후보로 볼 수 있습니다.',
    sellSignal: '고가권에서 위꼬리가 긴 양봉이 나오면 상승 힘이 약해지는 신호일 수 있습니다.',
    mistake: '양봉 하나만으로 방향을 단정하면 위험합니다. 몸통 크기와 거래량, 앞선 추세를 함께 봐야 합니다.',
    related: '거래량, 이동평균선, 지지선',
    detect: 'bullish',
  },
  {
    id: 'bearish',
    group: '캔들',
    title: '음봉',
    short: '종가가 시가보다 낮게 끝난 하락 캔들',
    concept:
      '음봉은 종가가 시가보다 낮게 끝난 캔들입니다. 몸통이 아래쪽 방향으로 형성되며 매도세가 우위였음을 뜻합니다.',
    condition: '종가 < 시가. 몸통이 아래 방향으로 형성되어 하락 마감된 경우입니다.',
    interpretation: '해당 구간에서 매도세가 우위였음을 보여줍니다. 연속 음봉은 단기 하락 흐름을 시사합니다.',
    buySignal: '과매도 구간이나 지지선 부근에서 음봉의 아래꼬리가 길어지면 반등 가능성을 함께 확인합니다.',
    sellSignal: '저항선 부근이나 거래량 증가와 함께 큰 음봉이 나오면 하락 전환 위험 신호일 수 있습니다.',
    mistake: '음봉이라고 무조건 나쁜 것은 아닙니다. 상승 중 쉬어가는 조정 음봉도 흔합니다.',
    related: '거래량, 저항선, RSI',
    detect: 'bearish',
  },
  {
    id: 'doji',
    group: '캔들',
    title: '도지',
    short: '시가와 종가가 거의 같은 결정 보류 캔들',
    concept:
      '도지는 시가와 종가가 거의 같아 몸통이 매우 작은 캔들입니다. 매수세와 매도세가 팽팽하게 맞선 상태를 뜻합니다.',
    condition: '몸통 길이가 전체 고가-저가 폭에 비해 매우 작은 경우(대략 10% 이하)입니다.',
    interpretation: '방향성 결정이 보류된 상태로, 추세의 힘이 약해지거나 전환될 수 있음을 암시합니다.',
    buySignal: '하락 추세 끝, 지지선 부근에서 도지가 나오고 다음 봉이 양봉이면 반등 후보로 봅니다.',
    sellSignal: '상승 추세 끝, 저항선 부근에서 도지가 나오면 상승 힘 소진 위험 신호일 수 있습니다.',
    mistake: '도지 자체는 방향을 알려주지 않습니다. 반드시 다음 봉과 위치(추세 상단/하단)를 확인해야 합니다.',
    related: '지지선, 저항선, 거래량',
    detect: 'doji',
  },
  {
    id: 'hammer',
    group: '캔들',
    title: '망치형',
    short: '아래꼬리가 긴 하락 반전 캔들',
    concept:
      '망치형은 몸통이 위쪽에 작게 있고 아래꼬리가 몸통의 2배 이상 긴 캔들입니다. 장중 크게 밀렸다가 다시 회복했음을 뜻합니다.',
    condition: '아래꼬리 길이 ≥ 몸통의 2배, 위꼬리는 매우 짧음. 주로 하락 추세 끝에서 의미가 큽니다.',
    interpretation: '저가에서 매수세가 강하게 들어와 반등이 시작될 수 있음을 암시합니다.',
    buySignal: '하락 추세 하단·지지선에서 망치형이 나오고 다음 봉이 양봉으로 확인되면 반등 후보입니다.',
    sellSignal: '상승 추세 고가권에서 나타난 비슷한 모양(교수형)은 오히려 하락 신호일 수 있습니다.',
    mistake: '위치를 무시하면 안 됩니다. 같은 모양도 하단이면 반등, 상단이면 하락 신호로 해석이 갈립니다.',
    related: '지지선, 거래량, RSI',
    detect: 'hammer',
  },
  {
    id: 'inverted-hammer',
    group: '캔들',
    title: '역망치형',
    short: '위꼬리가 긴 하락권 반전 시도 캔들',
    concept:
      '역망치형은 몸통이 아래쪽에 작게 있고 위꼬리가 몸통의 2배 이상 긴 캔들입니다. 장중 위로 크게 올랐다가 밀린 모습입니다.',
    condition: '위꼬리 길이 ≥ 몸통의 2배, 아래꼬리는 매우 짧음. 하락 추세 끝에서 의미가 큽니다.',
    interpretation: '하락권에서 매수 시도가 나왔음을 보여주며, 다음 봉이 확인되면 반등 가능성을 봅니다.',
    buySignal: '하락 추세 하단에서 역망치형 다음에 양봉이 나오면 반등 후보로 볼 수 있습니다.',
    sellSignal: '상승 고가권에서 나타난 유성형(비슷한 모양)은 하락 반전 신호일 수 있습니다.',
    mistake: '역망치형은 단독 확정 신호가 아니라 다음 봉 확인이 필요한 예비 신호입니다.',
    related: '거래량, 지지선, RSI',
    detect: 'invertedHammer',
  },
  {
    id: 'long-bullish',
    group: '캔들',
    title: '장대양봉',
    short: '몸통이 아주 큰 강한 상승 캔들',
    concept:
      '장대양봉은 몸통이 평소보다 훨씬 큰 양봉입니다. 강한 매수세가 하루 종일 우위였음을 뜻합니다.',
    condition: '몸통 크기가 최근 평균 몸통의 2배 이상이고 종가가 시가보다 크게 높은 경우입니다.',
    interpretation: '강한 매수 에너지가 유입된 상태로, 추세 시작이나 돌파 신호로 자주 쓰입니다.',
    buySignal: '박스권 상단·저항선을 거래량과 함께 장대양봉으로 돌파하면 상승 추세 후보로 봅니다.',
    sellSignal: '고가권에서 이미 많이 오른 뒤 나오는 장대양봉은 막바지 과열일 수 있습니다.',
    mistake: '거래량 없는 장대양봉은 신뢰도가 낮습니다. 반드시 거래량 동반 여부를 확인합니다.',
    related: '거래량, 저항선, 돌파',
    detect: 'longBullish',
  },
  {
    id: 'long-bearish',
    group: '캔들',
    title: '장대음봉',
    short: '몸통이 아주 큰 강한 하락 캔들',
    concept:
      '장대음봉은 몸통이 평소보다 훨씬 큰 음봉입니다. 강한 매도세가 하루 종일 우위였음을 뜻합니다.',
    condition: '몸통 크기가 최근 평균 몸통의 2배 이상이고 종가가 시가보다 크게 낮은 경우입니다.',
    interpretation: '강한 매도 압력이 유입된 상태로, 하락 추세 시작이나 지지 이탈 신호로 자주 쓰입니다.',
    buySignal: '과매도 구간에서 투매성 장대음봉 이후 반등이 나오면 바닥 확인 후 접근을 고려합니다.',
    sellSignal: '지지선을 거래량과 함께 장대음봉으로 이탈하면 추가 하락 위험 신호로 봅니다.',
    mistake: '장대음봉 하나로 공포 매도하면 저점에 팔 수 있습니다. 지지선과 거래량을 함께 봐야 합니다.',
    related: '거래량, 지지선, RSI',
    detect: 'longBearish',
  },
  {
    id: 'bullish-engulfing',
    group: '캔들',
    title: '상승장악형',
    short: '큰 양봉이 앞의 음봉을 완전히 감싸는 반전 패턴',
    concept:
      '상승장악형은 앞 봉이 음봉이고 다음 봉이 그 몸통을 완전히 감싸는 큰 양봉인 2봉 패턴입니다.',
    condition: '전일 음봉, 당일 양봉이며 당일 몸통이 전일 몸통을 완전히 포함하는 경우입니다.',
    interpretation: '매도세가 우위였다가 매수세가 강하게 역전했음을 보여주는 상승 반전 신호입니다.',
    buySignal: '하락 추세 하단·지지선에서 거래량 증가와 함께 나오면 반등 후보로 봅니다.',
    sellSignal: '상승이 많이 진행된 뒤 나오면 신뢰도가 낮습니다. 하단에서 나올 때 의미가 큽니다.',
    mistake: '몸통만 감싸면 되고 꼬리까지 감쌀 필요는 없습니다. 위치(하단)가 핵심입니다.',
    related: '지지선, 거래량, RSI',
    detect: 'bullishEngulfing',
  },
  {
    id: 'bearish-engulfing',
    group: '캔들',
    title: '하락장악형',
    short: '큰 음봉이 앞의 양봉을 완전히 감싸는 반전 패턴',
    concept:
      '하락장악형은 앞 봉이 양봉이고 다음 봉이 그 몸통을 완전히 감싸는 큰 음봉인 2봉 패턴입니다.',
    condition: '전일 양봉, 당일 음봉이며 당일 몸통이 전일 몸통을 완전히 포함하는 경우입니다.',
    interpretation: '매수세가 우위였다가 매도세가 강하게 역전했음을 보여주는 하락 반전 신호입니다.',
    buySignal: '이 패턴 자체는 매수 신호가 아닙니다. 지지선 확인 후 반등 여부를 기다립니다.',
    sellSignal: '상승 추세 상단·저항선에서 거래량과 함께 나오면 하락 전환 위험 신호로 봅니다.',
    mistake: '상승 초기에 나오는 경우는 신뢰도가 낮습니다. 고가권 위치가 핵심입니다.',
    related: '저항선, 거래량, RSI',
    detect: 'bearishEngulfing',
  },
  {
    id: 'morning-star',
    group: '캔들',
    title: '샛별형',
    short: '음봉·도지·양봉 3봉으로 이뤄진 상승 반전',
    concept:
      '샛별형은 큰 음봉 → 작은 몸통(도지형) → 큰 양봉의 3봉 패턴입니다. 하락 끝에서 반등이 시작되는 모습입니다.',
    condition: '1봉 음봉, 2봉 작은 몸통(갭 또는 약세 마무리), 3봉이 1봉 몸통 중간 이상까지 회복하는 양봉입니다.',
    interpretation: '하락 → 관망 → 매수 전환의 흐름으로, 대표적인 바닥권 상승 반전 신호입니다.',
    buySignal: '하락 추세 하단에서 거래량 증가와 함께 샛별형이 완성되면 반등 후보로 봅니다.',
    sellSignal: '이 패턴은 상승 반전 신호이므로 매도 신호로 쓰지 않습니다.',
    mistake: '3봉이 모두 확인되어야 완성입니다. 2봉만 보고 미리 진입하면 위험합니다.',
    related: '지지선, 거래량, RSI',
    detect: 'morningStar',
  },
  {
    id: 'evening-star',
    group: '캔들',
    title: '석별형',
    short: '양봉·도지·음봉 3봉으로 이뤄진 하락 반전',
    concept:
      '석별형(저녁별)은 큰 양봉 → 작은 몸통 → 큰 음봉의 3봉 패턴입니다. 상승 끝에서 하락이 시작되는 모습입니다.',
    condition: '1봉 양봉, 2봉 작은 몸통, 3봉이 1봉 몸통 중간 이하까지 하락하는 음봉입니다.',
    interpretation: '상승 → 관망 → 매도 전환의 흐름으로, 대표적인 고점권 하락 반전 신호입니다.',
    buySignal: '이 패턴은 하락 반전 신호이므로 매수 신호로 쓰지 않습니다.',
    sellSignal: '상승 추세 상단·저항선에서 거래량과 함께 석별형이 완성되면 하락 위험 신호로 봅니다.',
    mistake: '3봉이 모두 확인되어야 완성입니다. 상승 초기 위치에서는 신뢰도가 낮습니다.',
    related: '저항선, 거래량, RSI',
    detect: 'eveningStar',
  },

  // ── 차트 기초 ──────────────────────────────────────────
  {
    id: 'support',
    group: '차트 기초',
    title: '지지선',
    short: '주가가 반복해서 멈추고 되돌아선 아래쪽 가격대',
    concept:
      '지지선은 주가가 내려오다 매수세가 들어와 반복적으로 멈추고 반등하는 가격대입니다.',
    condition: '과거 저점이 비슷한 가격대에 여러 번 형성되고, 그 부근에서 반등이 반복될 때 지지선으로 봅니다.',
    interpretation: '지지선 부근에서는 매수세가 강해 하락이 멈추는 경향이 있습니다.',
    buySignal: '지지선 부근에서 반등 캔들(망치형·양봉)과 거래량이 나오면 저가 매수 후보로 봅니다.',
    sellSignal: '지지선이 거래량과 함께 깨지면 추가 하락 위험이 커집니다.',
    mistake: '지지선은 한 가격이 아니라 구간으로 봐야 하며 절대선이 아닙니다. 손절 기준이 필요합니다.',
    related: '거래량, 이동평균선, 캔들 패턴',
    detect: 'support',
  },
  {
    id: 'resistance',
    group: '차트 기초',
    title: '저항선',
    short: '주가가 반복해서 막히고 되돌아선 위쪽 가격대',
    concept:
      '저항선은 주가가 올라가다 매도세가 나와 반복적으로 막히는 가격대입니다.',
    condition: '과거 고점이 비슷한 가격대에 여러 번 형성되고, 그 부근에서 되돌림이 반복될 때 저항선으로 봅니다.',
    interpretation: '저항선 부근에서는 매도세가 강해 상승이 막히는 경향이 있습니다.',
    buySignal: '저항선을 거래량과 함께 종가로 돌파하면 상승 추세 전환 후보로 볼 수 있습니다.',
    sellSignal: '저항선에서 위꼬리가 길게 남고 밀리면 단기 매도·조정 신호일 수 있습니다.',
    mistake: '돌파한 척하다 되밀리는 가짜 돌파가 많습니다. 종가 기준 돌파를 확인해야 합니다.',
    related: '거래량, 돌파, 캔들 패턴',
    detect: 'resistance',
  },
  {
    id: 'trendline',
    group: '차트 기초',
    title: '추세선',
    short: '고점 또는 저점을 이어 방향을 확인하는 선',
    concept:
      '추세선은 연속된 저점(상승 추세)이나 고점(하락 추세)을 이어 그린 선으로, 현재 흐름의 방향과 각도를 보여줍니다.',
    condition: '상승 추세는 저점이 계속 높아지고, 하락 추세는 고점이 계속 낮아질 때 성립합니다.',
    interpretation: '추세선을 따라 움직이는 동안은 추세가 유지되고, 이탈하면 전환 가능성을 봅니다.',
    buySignal: '상승 추세선 부근으로 눌린 뒤 지지받고 반등하면 추세 지속 매수 후보로 봅니다.',
    sellSignal: '상승 추세선을 거래량과 함께 하향 이탈하면 추세 훼손 위험 신호입니다.',
    mistake: '기울기를 너무 급하게 그으면 잦은 이탈로 오판할 수 있습니다. 완만한 선이 더 유효합니다.',
    related: '이동평균선, 지지선, 거래량',
    detect: 'trendUp',
  },
  {
    id: 'box',
    group: '차트 기초',
    title: '박스권',
    short: '일정 범위 안에서 오르내리는 횡보 구간',
    concept:
      '박스권은 주가가 지지선과 저항선 사이 일정 범위에서 반복적으로 오르내리는 횡보 구간입니다.',
    condition: '고점과 저점이 비슷한 가격대에서 여러 번 반복되어 상·하단이 뚜렷할 때 성립합니다.',
    interpretation: '매수·매도 힘이 균형을 이룬 관망 상태로, 방향이 정해지기 전 에너지를 모으는 구간입니다.',
    buySignal: '박스 하단 지지 확인 후 반등, 또는 상단을 거래량과 함께 돌파할 때 접근을 고려합니다.',
    sellSignal: '박스 상단에서 막히거나 하단을 이탈하면 매도·관망 신호로 봅니다.',
    mistake: '박스권에서 상·하단마다 매매하면 가짜 돌파에 자주 당할 수 있습니다.',
    related: '지지선, 저항선, 거래량',
    detect: 'box',
  },
  {
    id: 'breakout',
    group: '차트 기초',
    title: '돌파',
    short: '저항선·박스 상단을 강하게 뚫는 움직임',
    concept:
      '돌파는 이전에 계속 막히던 저항선이나 박스권 상단을 종가로 강하게 뚫고 올라가는 움직임입니다.',
    condition: '종가가 직전 저항 구간 위에서 마감되고 거래량이 평소보다 크게 증가할 때 신뢰도가 높습니다.',
    interpretation: '매물대를 소화하고 새로운 상승 추세가 시작될 수 있음을 뜻합니다.',
    buySignal: '거래량 동반 종가 돌파 후 되돌림에서 지지받으면 상승 추세 초입 후보로 봅니다.',
    sellSignal: '돌파 직후 종가가 다시 저항선 아래로 밀리면 가짜 돌파 위험 신호입니다.',
    mistake: '장중 고가 돌파만 보고 진입하면 위험합니다. 종가 기준·거래량을 확인해야 합니다.',
    related: '저항선, 거래량, 장대양봉',
    detect: 'breakout',
  },
  {
    id: 'gap',
    group: '차트 기초',
    title: '갭',
    short: '전일 종가와 당일 시가가 크게 벌어진 빈 구간',
    concept:
      '갭은 전일 종가와 당일 시가 사이에 가격이 크게 벌어져 캔들이 겹치지 않는 빈 구간입니다. 강한 호재·악재나 시간외 수급으로 발생합니다.',
    condition: '당일 시가가 전일 고가보다 크게 높거나(상승 갭) 전일 저가보다 크게 낮게(하락 갭) 출발할 때입니다.',
    interpretation: '급격한 심리 변화를 반영하며, 갭이 유지되면 강한 추세, 메워지면 되돌림으로 봅니다.',
    buySignal: '거래량 동반 상승 갭이 눌림에도 메워지지 않고 지지되면 강세 지속 후보로 봅니다.',
    sellSignal: '상승 갭이 당일 바로 메워지며 음봉으로 밀리면 소진성 갭 위험 신호일 수 있습니다.',
    mistake: '모든 갭이 메워지는 것은 아닙니다. 갭 종류(돌파·소진·보통)를 구분해야 합니다.',
    related: '거래량, 저항선, 공시·뉴스',
    detect: 'gap',
  },
  {
    id: 'volume',
    group: '차트 기초',
    title: '거래량',
    short: '얼마나 많이 사고팔렸는지 나타내는 힘의 크기',
    concept:
      '거래량은 해당 구간에 거래된 주식 수로, 시장 참여자의 관심과 자금 유입 강도를 보여줍니다.',
    condition: '가격 변화와 함께 거래량이 평소 대비 크게 늘거나 줄 때 의미가 커집니다.',
    interpretation: '가격 상승 + 거래량 증가는 신뢰도 높은 상승, 거래량 없는 상승은 약한 상승으로 봅니다.',
    buySignal: '돌파·이평선 회복·신고가 시 거래량이 함께 증가하면 신뢰도가 올라갑니다.',
    sellSignal: '거래량이 급증했는데 위꼬리가 길고 종가가 밀리면 세력 이탈 신호일 수 있습니다.',
    mistake: '거래량 많음 = 무조건 상승은 아닙니다. 캔들 모양·종가 위치를 함께 봐야 합니다.',
    related: '캔들 패턴, 돌파, OBV',
    detect: 'volume',
  },

  // ── 보조지표 ──────────────────────────────────────────
  {
    id: 'moving-average',
    group: '보조지표',
    title: '이동평균선',
    short: '일정 기간 평균 가격을 이어 추세를 보는 선',
    concept:
      '이동평균선은 일정 기간 종가의 평균을 이은 선입니다. 5·20일은 단기, 60일은 중기, 120일은 장기 흐름을 봅니다.',
    condition: '주가가 이평선 위/아래에 있는지, 이평선들이 정배열(단기>장기)인지로 흐름을 판단합니다.',
    interpretation: '주가가 이평선 위에서 정배열이면 상승 흐름, 아래에서 역배열이면 하락 흐름으로 봅니다.',
    buySignal: '20일선을 회복하고 60일선까지 돌파하면 단기 추세 회복 후보로 봅니다.',
    sellSignal: '주가가 이평선들을 차례로 이탈하며 역배열로 바뀌면 하락 전환 위험 신호입니다.',
    mistake: '이평선은 과거 평균이라 항상 늦습니다. 돌파 직후 추격매수는 눌림에 걸릴 수 있습니다.',
    related: '거래량, 골든크로스, 추세선',
    detect: 'goldenCross',
  },
  {
    id: 'golden-cross',
    group: '보조지표',
    title: '골든크로스',
    short: '단기 이평선이 장기 이평선을 위로 뚫는 신호',
    concept:
      '골든크로스는 단기 이동평균선(예: 5일·20일)이 장기 이동평균선(예: 20일·60일)을 아래에서 위로 돌파하는 현상입니다.',
    condition: '전일까지 단기선 ≤ 장기선이었다가 당일 단기선 > 장기선으로 교차하는 시점입니다.',
    interpretation: '하락·횡보 흐름이 상승으로 전환될 수 있음을 시사하는 대표적 강세 신호입니다.',
    buySignal: '바닥권에서 거래량 증가와 함께 골든크로스가 나오면 추세 전환 후보로 봅니다.',
    sellSignal: '이 신호 자체는 매도 신호가 아니지만, 횡보장에서 잦은 교차는 손실을 키울 수 있습니다.',
    mistake: '이평선 기반이라 신호가 늦습니다. 횡보장에서는 골든크로스 직후 다시 꺾이기 쉽습니다.',
    related: '거래량, 이동평균선, MACD',
    detect: 'goldenCross',
  },
  {
    id: 'dead-cross',
    group: '보조지표',
    title: '데드크로스',
    short: '단기 이평선이 장기 이평선을 아래로 뚫는 신호',
    concept:
      '데드크로스는 단기 이동평균선이 장기 이동평균선을 위에서 아래로 뚫고 내려가는 현상입니다.',
    condition: '전일까지 단기선 ≥ 장기선이었다가 당일 단기선 < 장기선으로 교차하는 시점입니다.',
    interpretation: '상승·횡보 흐름이 하락으로 전환될 수 있음을 시사하는 대표적 약세 신호입니다.',
    buySignal: '이 신호 자체는 매수 신호가 아닙니다. 과매도 반등을 확인한 뒤 접근합니다.',
    sellSignal: '고가권에서 거래량 증가와 함께 데드크로스가 나오면 하락 전환 위험 신호입니다.',
    mistake: '이평선 기반이라 늦게 나옵니다. 이미 많이 빠진 뒤 신호가 나오기도 합니다.',
    related: '거래량, 이동평균선, MACD',
    detect: 'deadCross',
  },
  {
    id: 'rsi',
    group: '보조지표',
    title: 'RSI',
    short: '최근 상승·하락 힘을 0~100으로 나타내는 지표',
    concept:
      'RSI는 최근 일정 기간의 상승 폭과 하락 폭을 비교해 0~100 사이로 표시합니다. 보통 70 이상 과열, 30 이하 과매도로 봅니다.',
    condition: 'RSI가 30 이하로 내려가면 과매도, 70 이상으로 올라가면 과열 구간으로 판단합니다.',
    interpretation: '가격 모멘텀의 강도와 과열·침체 정도를 보여줍니다.',
    buySignal: 'RSI가 30 아래에서 다시 올라오며 주가가 지지선을 지키면 기술적 반등 후보로 봅니다.',
    sellSignal: 'RSI 70 이상 과열에서 거래량 없이 밀리거나 하락 다이버전스가 나오면 조정 위험 신호입니다.',
    mistake: '강한 추세장에서는 RSI가 과매도·과열에 오래 머뭅니다. RSI만으로 역추세 매매하면 위험합니다.',
    related: '지지선, 거래량, MACD',
    detect: 'rsiOversold',
  },
  {
    id: 'macd',
    group: '보조지표',
    title: 'MACD',
    short: '단기·장기 이평 차이로 추세 전환을 잡는 지표',
    concept:
      'MACD는 단기 이동평균에서 장기 이동평균을 뺀 값(MACD선)과 그 평균(시그널선), 두 선의 차이(히스토그램)로 구성됩니다.',
    condition: 'MACD선이 시그널선을 위로 뚫으면 골든크로스, 아래로 뚫으면 데드크로스로 판단합니다.',
    interpretation: '추세의 방향과 전환 시점, 모멘텀의 강도를 함께 보여줍니다.',
    buySignal: 'MACD선이 시그널선을 아래에서 위로 교차하고 히스토그램이 커지면 매수 관점으로 봅니다.',
    sellSignal: 'MACD선이 시그널선을 위에서 아래로 교차하거나 히스토그램이 줄면 매도·주의 관점입니다.',
    mistake: '이평 기반이라 신호가 늦고, 횡보장에서는 교차가 자주 어긋나 잦은 매매 손실이 납니다.',
    related: '이동평균선, 거래량, RSI',
    detect: 'macdCross',
  },
  {
    id: 'bollinger',
    group: '보조지표',
    title: '볼린저밴드',
    short: '평균선 위·아래로 변동 범위를 보여주는 밴드',
    concept:
      '볼린저밴드는 중심선(보통 20일 이동평균)과 표준편차로 만든 상단·하단 밴드로 가격의 변동 범위를 보여줍니다.',
    condition: '밴드 폭이 좁아졌다(수축) 넓어지거나(확장), 가격이 상·하단 밴드에 닿을 때 주목합니다.',
    interpretation: '밴드 수축은 변동성 축소, 확장은 변동성 확대를 뜻하며 상·하단은 상대적 과열·침체를 봅니다.',
    buySignal: '밴드 수축 후 거래량과 함께 상단을 돌파하면 변동성 확대 상승 후보로 봅니다.',
    sellSignal: '상단 밴드 접촉 후 거래량 없이 밀리면 단기 조정, 하단 이탈 지속은 약세 신호입니다.',
    mistake: '상단에 닿았다고 무조건 매도, 하단에 닿았다고 무조건 매수하면 강한 추세에서 크게 틀립니다.',
    related: '거래량, RSI, ATR',
    detect: 'bollingerBreak',
  },
  {
    id: 'volume-spike',
    group: '보조지표',
    title: '거래량 급증',
    short: '평소보다 거래량이 크게 폭증한 구간',
    concept:
      '거래량 급증은 특정 구간에 거래량이 평소 평균 대비 크게 폭증하는 현상으로, 강한 관심·수급 변화를 뜻합니다.',
    condition: '당일 거래량이 최근 20일 평균 거래량의 약 2.5배 이상으로 늘어난 경우입니다.',
    interpretation: '중요한 매수 또는 매도 이벤트가 발생했음을 보여주는 강한 신호입니다.',
    buySignal: '저항선·박스 상단 돌파 시 거래량이 급증하면 돌파 신뢰도가 높아집니다.',
    sellSignal: '고가권에서 거래량 급증과 함께 긴 위꼬리·음봉이 나오면 분산·이탈 위험 신호입니다.',
    mistake: '거래량만 보면 안 됩니다. 급증이 상승 때인지 하락 때인지(캔들 방향)를 함께 봐야 합니다.',
    related: '캔들 패턴, 돌파, OBV',
    detect: 'volume',
  },
  {
    id: 'atr',
    group: '보조지표',
    title: 'ATR',
    short: '하루 평균 변동폭을 나타내는 변동성 지표',
    concept:
      'ATR(평균 진폭)은 최근 일정 기간 하루 가격 변동폭의 평균으로, 종목이 하루에 평균 얼마나 움직이는지 보여줍니다.',
    condition: 'ATR이 커지면 변동성 확대, 작아지면 변동성 축소로 판단합니다.',
    interpretation: '방향이 아니라 변동성의 크기를 보여줍니다. 손절폭·주문 수량 조절에 활용합니다.',
    buySignal: '횡보 중 ATR이 낮았다가 거래량과 함께 커지면 큰 움직임 시작 여부를 확인합니다.',
    sellSignal: 'ATR 급등은 위험 급증도 뜻하므로 변동성이 큰 구간은 비중·손절 관리를 강화합니다.',
    mistake: 'ATR은 방향을 알려주지 않습니다. 값이 커졌다고 상승 신호로 해석하면 안 됩니다.',
    related: '볼린저밴드, 거래량, 캔들 패턴',
    detect: 'atrSpike',
  },
  {
    id: 'stochastic',
    group: '보조지표',
    title: '스토캐스틱',
    short: '최근 범위 내 종가 위치로 과열·침체를 보는 지표',
    concept:
      '스토캐스틱은 최근 일정 기간의 고가~저가 범위에서 현재 종가가 어디에 있는지를 %K, %D 선으로 나타냅니다. 보통 80 이상 과열, 20 이하 과매도로 봅니다.',
    condition: '%K가 20 이하로 내려가면 과매도, 80 이상으로 올라가면 과열 구간으로 판단합니다.',
    interpretation: '단기 모멘텀의 과열·침체와 반전 시점을 민감하게 보여줍니다.',
    buySignal: '과매도(20 이하)에서 %K가 %D를 위로 교차하며 올라오면 단기 반등 후보로 봅니다.',
    sellSignal: '과열(80 이상)에서 %K가 %D를 아래로 교차하면 단기 조정 신호일 수 있습니다.',
    mistake: '민감해서 신호가 잦습니다. 강한 추세장에서는 과열·과매도에 오래 머물러 오판하기 쉽습니다.',
    related: 'RSI, 거래량, 지지선',
    detect: 'stochOversold',
  },
  {
    id: 'obv',
    group: '보조지표',
    title: 'OBV',
    short: '상승일·하락일 거래량을 누적해 수급을 보는 지표',
    concept:
      'OBV(누적 거래량)는 주가가 오른 날 거래량을 더하고 내린 날 빼서 누적해, 자금이 매집되는지 이탈하는지를 보여줍니다.',
    condition: '주가와 OBV의 방향이 같은지(동행) 다른지(다이버전스)를 비교합니다.',
    interpretation: '가격보다 수급의 방향이 먼저 드러나는 경우가 많아 선행 신호로 활용됩니다.',
    buySignal: '주가는 횡보·하락인데 OBV 저점이 계속 높아지면 매집(강세 다이버전스) 후보로 봅니다.',
    sellSignal: '주가는 오르는데 OBV가 하락하면 상승 힘 약화(약세 다이버전스) 위험 신호입니다.',
    mistake: '대량 거래 한 번에 값이 크게 왜곡될 수 있어 공시·블록딜 여부를 함께 봐야 합니다.',
    related: '거래량, 캔들 패턴, 이동평균선',
    detect: 'obvUp',
  },
];

const GROUPS: StudyGroup[] = ['캔들', '차트 기초', '보조지표'];

// ── 실데이터 사례 탐지 유틸 ─────────────────────────────
interface Occurrence {
  index: number;
  date: string;
  price: number;
  condition: string;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function toRows(candles: Candle[]) {
  return candles
    .map((c) => ({
      time: String(c.time),
      open: num(c.open),
      high: num(c.high),
      low: num(c.low),
      close: num(c.close),
      volume: num(c.volume),
    }))
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

function fmtDate(time: string): string {
  if (!time) return '정보 없음';
  const digits = time.replace(/[^0-9]/g, '');
  if (digits.length >= 8) {
    return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}`;
  }
  return time;
}

function sma(values: number[], period: number, at: number): number | null {
  if (at < period - 1) return null;
  let sum = 0;
  for (let i = at - period + 1; i <= at; i += 1) sum += values[i];
  return sum / period;
}

function computeRsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i += 1) {
    if (prev == null) {
      if (i >= period - 1) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j += 1) sum += values[j];
        prev = sum / period;
        out[i] = prev;
      }
    } else {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

type Row = ReturnType<typeof toRows>[number];

function body(r: Row) {
  return Math.abs(r.close - r.open);
}
function range(r: Row) {
  return Math.max(r.high - r.low, 1e-9);
}
function isBull(r: Row) {
  return r.close > r.open;
}
function isBear(r: Row) {
  return r.close < r.open;
}
function avgBody(rows: Row[], at: number, period = 20) {
  const from = Math.max(0, at - period);
  const slice = rows.slice(from, at);
  if (!slice.length) return 0;
  return slice.reduce((s, r) => s + body(r), 0) / slice.length;
}

function detectOccurrences(kind: DetectKind, rows: Row[]): Occurrence[] {
  const out: Occurrence[] = [];
  const closes = rows.map((r) => r.close);
  const n = rows.length;
  const push = (i: number, condition: string) =>
    out.push({ index: i, date: fmtDate(rows[i].time), price: rows[i].close, condition });

  const rsi = computeRsi(closes);

  for (let i = 0; i < n; i += 1) {
    const r = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    switch (kind) {
      case 'bullish':
        if (isBull(r) && body(r) >= avgBody(rows, i) * 0.8)
          push(i, `종가 ${r.close.toLocaleString()} > 시가 ${r.open.toLocaleString()} (상승 마감)`);
        break;
      case 'bearish':
        if (isBear(r) && body(r) >= avgBody(rows, i) * 0.8)
          push(i, `종가 ${r.close.toLocaleString()} < 시가 ${r.open.toLocaleString()} (하락 마감)`);
        break;
      case 'doji':
        if (body(r) <= range(r) * 0.1)
          push(i, `몸통이 고저폭의 10% 이하 (시가·종가 거의 동일)`);
        break;
      case 'hammer': {
        const lower = Math.min(r.open, r.close) - r.low;
        const upper = r.high - Math.max(r.open, r.close);
        if (lower >= body(r) * 2 && upper <= body(r) && body(r) > 0)
          push(i, `아래꼬리가 몸통의 2배 이상 (저가 반등)`);
        break;
      }
      case 'invertedHammer': {
        const lower = Math.min(r.open, r.close) - r.low;
        const upper = r.high - Math.max(r.open, r.close);
        if (upper >= body(r) * 2 && lower <= body(r) && body(r) > 0)
          push(i, `위꼬리가 몸통의 2배 이상`);
        break;
      }
      case 'longBullish':
        if (isBull(r) && body(r) >= avgBody(rows, i) * 2 && avgBody(rows, i) > 0)
          push(i, `몸통이 최근 평균의 2배 이상인 양봉`);
        break;
      case 'longBearish':
        if (isBear(r) && body(r) >= avgBody(rows, i) * 2 && avgBody(rows, i) > 0)
          push(i, `몸통이 최근 평균의 2배 이상인 음봉`);
        break;
      case 'bullishEngulfing':
        if (
          prev &&
          isBear(prev) &&
          isBull(r) &&
          r.close >= prev.open &&
          r.open <= prev.close
        )
          push(i, `양봉이 전일 음봉 몸통을 완전히 감쌈`);
        break;
      case 'bearishEngulfing':
        if (
          prev &&
          isBull(prev) &&
          isBear(r) &&
          r.open >= prev.close &&
          r.close <= prev.open
        )
          push(i, `음봉이 전일 양봉 몸통을 완전히 감쌈`);
        break;
      case 'morningStar':
        if (i >= 2) {
          const a = rows[i - 2];
          const b = rows[i - 1];
          if (
            isBear(a) &&
            body(a) >= avgBody(rows, i - 2) &&
            body(b) <= range(b) * 0.4 &&
            isBull(r) &&
            r.close >= a.open - body(a) / 2 &&
            r.close > (a.open + a.close) / 2
          )
            push(i, `음봉→작은 몸통→양봉 3봉 상승 반전`);
        }
        break;
      case 'eveningStar':
        if (i >= 2) {
          const a = rows[i - 2];
          const b = rows[i - 1];
          if (
            isBull(a) &&
            body(a) >= avgBody(rows, i - 2) &&
            body(b) <= range(b) * 0.4 &&
            isBear(r) &&
            r.close < (a.open + a.close) / 2
          )
            push(i, `양봉→작은 몸통→음봉 3봉 하락 반전`);
        }
        break;
      case 'gap':
        if (prev && (r.low > prev.high || r.high < prev.low)) {
          const up = r.low > prev.high;
          push(i, up ? `상승 갭 (당일 저가 > 전일 고가)` : `하락 갭 (당일 고가 < 전일 저가)`);
        }
        break;
      case 'volume': {
        const va = sma(rows.map((x) => x.volume), 20, i - 1);
        if (va != null && va > 0 && r.volume >= va * 2.5)
          push(i, `거래량이 20일 평균의 2.5배 이상 (${Math.round(r.volume / va * 10) / 10}배)`);
        break;
      }
      case 'atrSpike': {
        if (i >= 15) {
          const trs: number[] = [];
          for (let j = i - 13; j <= i; j += 1) {
            const p = rows[j - 1];
            trs.push(
              Math.max(
                rows[j].high - rows[j].low,
                p ? Math.abs(rows[j].high - p.close) : 0,
                p ? Math.abs(rows[j].low - p.close) : 0,
              ),
            );
          }
          const atr = trs.reduce((s, v) => s + v, 0) / trs.length;
          const tr = Math.max(
            r.high - r.low,
            prev ? Math.abs(r.high - prev.close) : 0,
            prev ? Math.abs(r.low - prev.close) : 0,
          );
          if (atr > 0 && tr >= atr * 2)
            push(i, `당일 진폭이 14일 ATR의 2배 이상 (변동성 확대)`);
        }
        break;
      }
      case 'rsiOversold': {
        const cur = rsi[i];
        const before = rsi[i - 1];
        if (cur != null && before != null && before < 30 && cur >= 30)
          push(i, `RSI 과매도(30 미만) 이탈 회복 (${Math.round(cur)})`);
        break;
      }
      case 'rsiOverbought': {
        const cur = rsi[i];
        const before = rsi[i - 1];
        if (cur != null && before != null && before > 70 && cur <= 70)
          push(i, `RSI 과열(70 초과) 이탈 (${Math.round(cur)})`);
        break;
      }
      default:
        break;
    }
  }

  // 이동평균 교차·돌파·지지·저항·MACD·볼린저·스토캐스틱·OBV 등 별도 처리
  if (kind === 'goldenCross' || kind === 'deadCross') {
    for (let i = 1; i < n; i += 1) {
      const shortPrev = sma(closes, 5, i - 1);
      const shortCur = sma(closes, 5, i);
      const longPrev = sma(closes, 20, i - 1);
      const longCur = sma(closes, 20, i);
      if (shortPrev == null || shortCur == null || longPrev == null || longCur == null) continue;
      if (kind === 'goldenCross' && shortPrev <= longPrev && shortCur > longCur)
        push(i, `5일선이 20일선을 상향 돌파 (골든크로스)`);
      if (kind === 'deadCross' && shortPrev >= longPrev && shortCur < longCur)
        push(i, `5일선이 20일선을 하향 이탈 (데드크로스)`);
    }
  }

  if (kind === 'macdCross') {
    const macdLine = ema(closes, 12).map((v, i) => {
      const slow = ema(closes, 26)[i];
      return v != null && slow != null ? v - slow : null;
    });
    const validMacd = macdLine.map((v) => (v == null ? 0 : v));
    const signal = ema(validMacd, 9);
    for (let i = 1; i < n; i += 1) {
      const mp = macdLine[i - 1];
      const mc = macdLine[i];
      const sp = signal[i - 1];
      const sc = signal[i];
      if (mp == null || mc == null || sp == null || sc == null) continue;
      if (mp <= sp && mc > sc) push(i, `MACD선이 시그널선 상향 돌파 (골든크로스)`);
    }
  }

  if (kind === 'bollingerBreak') {
    for (let i = 20; i < n; i += 1) {
      const mid = sma(closes, 20, i);
      if (mid == null) continue;
      let variance = 0;
      for (let j = i - 19; j <= i; j += 1) variance += (closes[j] - mid) ** 2;
      const sd = Math.sqrt(variance / 20);
      const upper = mid + sd * 2;
      const prevClose = closes[i - 1];
      if (prevClose <= upper && closes[i] > upper)
        push(i, `종가가 볼린저 상단 밴드를 상향 돌파`);
    }
  }

  if (kind === 'stochOversold') {
    for (let i = 14; i < n; i += 1) {
      const window = rows.slice(i - 13, i + 1);
      const hi = Math.max(...window.map((x) => x.high));
      const lo = Math.min(...window.map((x) => x.low));
      const kCur = hi === lo ? 50 : ((rows[i].close - lo) / (hi - lo)) * 100;
      const prevWindow = rows.slice(i - 14, i);
      const hiP = Math.max(...prevWindow.map((x) => x.high));
      const loP = Math.min(...prevWindow.map((x) => x.low));
      const kPrev = hiP === loP ? 50 : ((rows[i - 1].close - loP) / (hiP - loP)) * 100;
      if (kPrev < 20 && kCur >= 20)
        push(i, `스토캐스틱 %K 과매도(20 미만) 회복 (${Math.round(kCur)})`);
    }
  }

  if (kind === 'obvUp') {
    const obv: number[] = [0];
    for (let i = 1; i < n; i += 1) {
      const delta = closes[i] > closes[i - 1] ? rows[i].volume : closes[i] < closes[i - 1] ? -rows[i].volume : 0;
      obv.push(obv[i - 1] + delta);
    }
    for (let i = 10; i < n; i += 1) {
      const priceDown = closes[i] <= closes[i - 10];
      const obvUp = obv[i] > obv[i - 10];
      if (priceDown && obvUp)
        push(i, `주가 횡보·하락 중 OBV 상승 (매집 다이버전스)`);
    }
  }

  if (kind === 'support' || kind === 'resistance' || kind === 'breakout' || kind === 'box' || kind === 'trendUp') {
    // 최근 스윙 고점·저점 기준 판정
    const lookback = 10;
    for (let i = lookback + 1; i < n; i += 1) {
      const past = rows.slice(Math.max(0, i - 60), i);
      if (past.length < lookback) continue;
      const swingLow = Math.min(...past.map((x) => x.low));
      const swingHigh = Math.max(...past.map((x) => x.high));
      const r = rows[i];
      const prevR = rows[i - 1];
      const tolLow = swingLow * 0.02;
      if (kind === 'support' && Math.abs(r.low - swingLow) <= tolLow && isBull(r))
        push(i, `최근 저점(${Math.round(swingLow).toLocaleString()}) 부근 반등`);
      if (kind === 'resistance' && prevR.close <= swingHigh && r.close > swingHigh)
        push(i, `최근 고점(${Math.round(swingHigh).toLocaleString()}) 저항 돌파`);
      if (kind === 'breakout' && prevR.close <= swingHigh && r.close > swingHigh && body(r) >= avgBody(rows, i))
        push(i, `저항선 종가 돌파 (강한 양봉)`);
      if (kind === 'trendUp' && i >= 20) {
        const maNow = sma(closes, 20, i);
        const maPast = sma(closes, 20, i - 5);
        if (maNow != null && maPast != null && maNow > maPast && r.close > maNow && prevR.close <= (sma(closes, 20, i - 1) ?? Infinity))
          push(i, `상승 추세선(20일선) 지지 후 반등`);
      }
    }
    if (kind === 'box') {
      // 60봉 창에서 고저폭이 좁게 유지되는 마지막 구간 1건만 표기
      for (let i = n - 1; i >= 40; i -= 1) {
        const w = rows.slice(i - 39, i + 1);
        const hi = Math.max(...w.map((x) => x.high));
        const lo = Math.min(...w.map((x) => x.low));
        if (lo > 0 && (hi - lo) / lo <= 0.12) {
          push(i, `최근 40봉이 약 ${Math.round(((hi - lo) / lo) * 100)}% 범위에서 횡보 (박스권)`);
          break;
        }
      }
    }
  }

  // 최신 순 정렬, 중복 인덱스 제거
  const seen = new Set<number>();
  return out
    .filter((o) => {
      if (seen.has(o.index)) return false;
      seen.add(o.index);
      return true;
    })
    .sort((a, b) => b.index - a.index);
}

// ── 페이지 컴포넌트 ────────────────────────────────────
export default function LearnPage() {
  const [, navigate] = useLocation();
  // 페이지 진입 시 모든 카드 접힘 상태로 시작 (openIds 비움)
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());

  const toggle = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-background">
      <header className="relative z-20 border-b border-card-border bg-background/95 px-4 pb-4 pt-5 text-center glass">
        <h1 className="text-2xl font-extrabold">공부</h1>

        <p className="mx-auto mt-2 max-w-md break-keep text-center text-sm font-semibold leading-relaxed text-muted-foreground">
          캔들·차트 기초·보조지표를 쉬운 설명과 실제 차트로 배웁니다.
        </p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => navigate('/stock-info')}
            className="rounded-xl border border-card-border bg-card px-3 py-2 text-center text-sm font-black text-muted-foreground"
          >
            정보
          </button>
          <button
            type="button"
            className="rounded-xl border border-primary bg-primary px-3 py-2 text-center text-sm font-black text-primary-foreground"
          >
            공부
          </button>
        </div>
      </header>

      <main className="flex-none px-4 pb-28 pt-4">
        <div className="mb-4 flex items-start gap-2 rounded-2xl border border-card-border bg-secondary/60 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="break-keep text-center text-xs font-bold leading-relaxed text-muted-foreground">
            {NOTICE}
          </p>
        </div>

        <div className="space-y-6">
          {GROUPS.map((group) => {
            const topics = TOPICS.filter((t) => t.group === group);
            return (
              <section key={group}>
                <h2 className="mb-3 text-center text-lg font-extrabold text-muted-foreground">
                  {group}
                </h2>
                <div className="space-y-3">
                  {topics.map((topic) => (
                    <TopicCard
                      key={topic.id}
                      topic={topic}
                      open={openIds.has(topic.id)}
                      onToggle={() => toggle(topic.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </main>

      <BottomNav />
    </div>
  );
}

function TopicCard({
  topic,
  open,
  onToggle,
}: {
  topic: StudyTopic;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="rounded-3xl border border-card-border bg-card shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-4 text-center"
      >
        <span className="flex-1 text-center">
          <span className="block text-base font-black">{topic.title}</span>
          {!open && (
            <span className="mt-1 block break-keep text-xs font-semibold text-muted-foreground">
              {topic.short}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'h-5 w-5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="border-t border-card-border px-4 pb-4 pt-4">
          <div className="space-y-4">
            <Section title="개념 설명">{topic.concept}</Section>
            <Section title="발생 조건">{topic.condition}</Section>
            <Section title="일반적인 해석">{topic.interpretation}</Section>
            <Section title="매수 신호로 볼 수 있는 경우" tone="positive">
              {topic.buySignal}
            </Section>
            <Section title="매도 또는 위험 신호" tone="danger">
              {topic.sellSignal}
            </Section>
            <Section title="잘못 해석하기 쉬운 점" tone="warn">
              {topic.mistake}
            </Section>
            <Section title="함께 확인하면 좋은 다른 지표">{topic.related}</Section>

            <RealExample topic={topic} />
          </div>
        </div>
      )}
    </section>
  );
}

function Section({
  title,
  children,
  tone = 'normal',
}: {
  title: string;
  children: ReactNode;
  tone?: 'normal' | 'positive' | 'danger' | 'warn';
}) {
  const textClass =
    tone === 'positive'
      ? 'text-positive'
      : tone === 'danger'
        ? 'text-destructive'
        : tone === 'warn'
          ? 'text-foreground'
          : 'text-foreground';
  return (
    <div className="rounded-2xl bg-secondary/40 p-3 text-center">
      <p className="mb-1.5 text-center text-sm font-extrabold text-primary">{title}</p>
      <p
        className={cn(
          'break-keep text-center text-sm font-semibold leading-relaxed',
          textClass,
        )}
      >
        {children}
      </p>
    </div>
  );
}

// ── 실제 차트 예시 ──────────────────────────────────────
function RealExample({ topic }: { topic: StudyTopic }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="rounded-2xl border border-card-border bg-background/70 p-3 text-center">
      <p className="mb-2 text-center text-sm font-extrabold text-primary">실제 차트 예시</p>
      {!loaded ? (
        <button
          type="button"
          onClick={() => setLoaded(true)}
          className="mx-auto rounded-full bg-primary px-4 py-2 text-center text-sm font-black text-primary-foreground transition active:scale-[0.98]"
        >
          실제 차트 예시 보기
        </button>
      ) : (
        <RealExampleChart topic={topic} />
      )}
    </div>
  );
}

function RealExampleChart({ topic }: { topic: StudyTopic }) {
  const chart = useQuery({
    queryKey: ['learn-example-chart', topic.detect, DEFAULT_TICKER],
    queryFn: () => api.chart(DEFAULT_TICKER, '1D'),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(() => (chart.data ? toRows(chart.data.candles) : []), [chart.data]);
  const occurrences = useMemo(
    () => (rows.length ? detectOccurrences(topic.detect, rows) : []),
    [rows, topic.detect],
  );
  const drawing = useMemo(() => buildChart(rows, occurrences), [rows, occurrences]);

  if (chart.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center rounded-2xl bg-secondary/60 text-center text-sm font-bold text-muted-foreground">
        실제 일봉 차트를 불러오는 중...
      </div>
    );
  }

  if (chart.isError || rows.length < 5) {
    return (
      <div className="flex h-40 items-center justify-center rounded-2xl bg-secondary/60 px-4 text-center text-sm font-bold leading-relaxed text-muted-foreground">
        차트 데이터를 제공받지 못했습니다. 데이터 부족으로 예시를 표시할 수 없습니다.
      </div>
    );
  }

  return (
    <div>
      <p className="mb-2 text-center text-xs font-bold text-muted-foreground">
        {DEFAULT_TICKER_NAME} ({DEFAULT_TICKER}) 일봉 · 최근 {rows.length}봉 기준
      </p>

      {drawing && (
        <div className="overflow-hidden rounded-2xl border border-card-border bg-background/70 p-2">
          <svg viewBox="0 0 640 260" role="img" aria-label={`${topic.title} 실제 차트 예시`} className="h-auto w-full">
            {[40, 80, 120, 160].map((y) => (
              <line key={y} x1="14" x2="626" y1={y} y2={y} stroke="hsl(var(--card-border))" strokeWidth="1" />
            ))}
            <polyline
              points={drawing.maPoints}
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            {drawing.candles.map((item) => (
              <g key={item.key}>
                <line
                  x1={item.x}
                  x2={item.x}
                  y1={item.highY}
                  y2={item.lowY}
                  stroke={item.up ? 'hsl(var(--positive))' : 'hsl(var(--destructive))'}
                  strokeWidth="1.2"
                />
                <rect
                  x={item.x - item.width / 2}
                  y={item.bodyY}
                  width={item.width}
                  height={Math.max(item.bodyHeight, 1.2)}
                  rx="1"
                  fill={item.up ? 'hsl(var(--positive))' : 'hsl(var(--destructive))'}
                />
              </g>
            ))}
            {drawing.markers.map((m) => (
              <g key={`mark:${m.index}`}>
                <line x1={m.x} x2={m.x} y1="16" y2="196" stroke="hsl(var(--primary) / 0.35)" strokeWidth="1" strokeDasharray="3 3" />
                <circle cx={m.x} cy={m.y} r="4.5" fill="hsl(var(--primary))" stroke="hsl(var(--background))" strokeWidth="1.5" />
              </g>
            ))}
            {drawing.volumeBars.map((item) => (
              <rect
                key={`v:${item.key}`}
                x={item.x - item.width / 2}
                y={item.y}
                width={item.width}
                height={item.height}
                rx="1"
                fill={item.up ? 'hsl(var(--positive) / 0.45)' : 'hsl(var(--destructive) / 0.45)'}
              />
            ))}
          </svg>
        </div>
      )}

      {occurrences.length === 0 ? (
        <div className="mt-3 rounded-2xl bg-secondary/60 px-4 py-4 text-center">
          <p className="break-keep text-center text-sm font-bold leading-relaxed text-muted-foreground">
            최근 조회 범위에서 사례 없음
          </p>
        </div>
      ) : (
        <div className="mt-3">
          <p className="mb-2 text-center text-sm font-extrabold text-primary">
            최근 발생 사례 {occurrences.length}건
          </p>
          <div className="space-y-2">
            {occurrences.slice(0, 6).map((o) => (
              <div
                key={o.index}
                className="rounded-2xl border border-card-border bg-background/80 p-3 text-center"
              >
                <div className="flex items-center justify-center gap-3">
                  <span className="text-sm font-extrabold">{o.date}</span>
                  <span className="text-sm font-extrabold text-primary">
                    {o.price.toLocaleString()}원
                  </span>
                </div>
                <p className="mt-1 break-keep text-center text-xs font-semibold leading-relaxed text-muted-foreground">
                  {o.condition}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function buildChart(rows: Row[], occurrences: Occurrence[]) {
  if (rows.length < 5) return null;
  const width = 612;
  const left = 14;
  const top = 20;
  const height = 160;
  const lows = rows.map((r) => r.low);
  const highs = rows.map((r) => r.high);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const priceRange = Math.max(max - min, Math.abs(max) * 0.01, 1);
  const step = width / rows.length;
  const yOf = (price: number) => top + ((max - price) / priceRange) * height;

  const candles = rows.map((r, i) => {
    const x = left + step * i + step / 2;
    const openY = yOf(r.open);
    const closeY = yOf(r.close);
    return {
      key: `${r.time}:${i}`,
      x,
      highY: yOf(r.high),
      lowY: yOf(r.low),
      bodyY: Math.min(openY, closeY),
      bodyHeight: Math.abs(openY - closeY),
      width: Math.max(1.6, Math.min(7, step * 0.6)),
      up: r.close >= r.open,
    };
  });

  const maPoints = rows
    .map((_, i) => {
      const from = Math.max(0, i - 19);
      const slice = rows.slice(from, i + 1);
      const avg = slice.reduce((s, r) => s + r.close, 0) / slice.length;
      return `${left + step * i + step / 2},${yOf(avg)}`;
    })
    .join(' ');

  const maxVolume = Math.max(...rows.map((r) => r.volume), 1);
  const volumeTop = 200;
  const volumeHeight = 48;
  const volumeBars = rows.map((r, i) => {
    const barHeight = Math.max(1, (r.volume / maxVolume) * volumeHeight);
    return {
      key: `${r.time}:${i}`,
      x: left + step * i + step / 2,
      y: volumeTop + volumeHeight - barHeight,
      height: barHeight,
      width: Math.max(1, Math.min(7, step * 0.6)),
      up: r.close >= r.open,
    };
  });

  const markers = occurrences.slice(0, 12).map((o) => ({
    index: o.index,
    x: left + step * o.index + step / 2,
    y: yOf(rows[o.index].close),
  }));

  return { candles, maPoints, volumeBars, markers };
}
