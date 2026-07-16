import {
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'wouter';
import {
  AlertTriangle,
  ChevronDown,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { cn } from '@/lib/utils';
import {
  StudyChart,
  type StudyChartConfig,
} from '@/components/study-chart';
import type { PatternKind, SignalKind } from '@/lib/study-detect';

// ── 공부 페이지 ──────────────────────────────────────────────
// 교육 목적 전용. 실제 매수·매도 권유가 아니며, 데이터가 없으면
// '정보 없음' / '데이터 부족' / '제공 불가'로 표기한다. 실제 차트 예시는
// api.chart 로 불러온 실데이터에서만 사례를 탐지한다.

type StudyGroup = '캔들' | '차트 기초' | '보조지표' | '차트 패턴';

// 실제 차트에서 사례를 탐지할 때 사용하는 신호 종류 (study-detect의 SignalKind 사용)
type DetectKind = SignalKind;

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
  // 신호 기반 항목(캔들/차트 기초/보조지표)
  detect?: DetectKind;
  // 패턴 기반 항목(차트 패턴)
  pattern?: PatternKind;
  // 주제별 하단 보조지표 표시
  showRsi?: boolean;
  showMacd?: boolean;
}

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
    showRsi: true,
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
    detect: 'macdBuy',
    showMacd: true,
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

  // ── 차트 패턴 ──────────────────────────────────────────
  {
    id: 'pattern-double-bottom',
    group: '차트 패턴',
    title: '쌍바닥',
    short: '비슷한 높이의 두 저점(W자)으로 만드는 바닥 반전',
    concept:
      '쌍바닥은 비슷한 가격대의 저점을 두 번 만든 뒤 그 사이 고점(넥라인)을 돌파하며 상승 반전하는 W자 패턴입니다.',
    condition: '두 저점이 대략 ±3% 이내로 비슷하고, 두 저점 사이 고점(넥라인)을 종가로 돌파할 때 완성됩니다.',
    interpretation: '두 번의 매도 시도가 실패하고 매수세가 우위로 돌아섰음을 뜻합니다.',
    buySignal: '넥라인을 거래량 증가와 함께 종가로 돌파하면 상승 반전 후보로 봅니다.',
    sellSignal: '넥라인 돌파에 실패하고 두 번째 저점마저 이탈하면 하락 지속 위험 신호입니다.',
    mistake: '넥라인 돌파 전에 미리 진입하면 두 번째 저점 이탈에 걸릴 수 있습니다.',
    related: '거래량, 지지선, 넥라인. 손절은 두 번째 저점 아래로 잡습니다. 넥라인 돌파 시 거래량 증가를 함께 확인하세요.',
    pattern: 'doubleBottom',
  },
  {
    id: 'pattern-double-top',
    group: '차트 패턴',
    title: '쌍봉',
    short: '비슷한 높이의 두 고점(M자)으로 만드는 천장 반전',
    concept:
      '쌍봉은 비슷한 가격대의 고점을 두 번 만든 뒤 그 사이 저점(넥라인)을 이탈하며 하락 반전하는 M자 패턴입니다.',
    condition: '두 고점이 대략 ±3% 이내로 비슷하고, 두 고점 사이 저점(넥라인)을 종가로 이탈할 때 완성됩니다.',
    interpretation: '두 번의 상승 시도가 실패하고 매도세가 우위로 돌아섰음을 뜻합니다.',
    buySignal: '이 패턴은 하락 반전형이므로 매수 신호로 쓰지 않습니다.',
    sellSignal: '넥라인을 거래량과 함께 종가로 이탈하면 하락 반전 위험 신호로 봅니다.',
    mistake: '두 고점 높이가 크게 다르면 신뢰도가 낮습니다. 넥라인 이탈 확인이 핵심입니다.',
    related: '거래량, 저항선, 넥라인. 손절은 두 번째 고점 위로 잡습니다. 넥라인 이탈 시 거래량을 함께 확인하세요.',
    pattern: 'doubleTop',
  },
  {
    id: 'pattern-head-shoulders',
    group: '차트 패턴',
    title: '머리어깨형',
    short: '왼쪽 어깨·머리·오른쪽 어깨 3고점 천장 반전',
    concept:
      '머리어깨형은 가운데 고점(머리)이 가장 높고 양옆 고점(어깨)이 비슷한 3고점 패턴으로, 대표적인 천장 반전형입니다.',
    condition: '머리가 양 어깨보다 높고, 두 어깨가 비슷하며, 어깨 저점을 이은 넥라인을 종가로 이탈할 때 완성됩니다.',
    interpretation: '상승 추세의 힘이 점차 약해지며 하락으로 전환됨을 뜻합니다.',
    buySignal: '이 패턴은 하락 반전형이므로 매수 신호로 쓰지 않습니다.',
    sellSignal: '넥라인을 거래량과 함께 이탈하면 하락 전환 위험 신호로 봅니다.',
    mistake: '완성 전(오른쪽 어깨 형성 중)에 단정하면 안 됩니다. 넥라인 이탈로 확인해야 합니다.',
    related: '거래량, 넥라인, 저항선. 손절은 오른쪽 어깨 고점 위로 잡습니다. 이탈 시 거래량 증가를 확인하세요.',
    pattern: 'headShoulders',
  },
  {
    id: 'pattern-inv-head-shoulders',
    group: '차트 패턴',
    title: '역머리어깨형',
    short: '뒤집힌 머리어깨형(3저점) 바닥 반전',
    concept:
      '역머리어깨형은 가운데 저점(머리)이 가장 낮고 양옆 저점(어깨)이 비슷한 3저점 패턴으로, 대표적인 바닥 반전형입니다.',
    condition: '머리가 양 어깨보다 낮고, 두 어깨가 비슷하며, 어깨 고점을 이은 넥라인을 종가로 돌파할 때 완성됩니다.',
    interpretation: '하락 추세의 힘이 약해지며 상승으로 전환됨을 뜻합니다.',
    buySignal: '넥라인을 거래량 증가와 함께 돌파하면 상승 반전 후보로 봅니다.',
    sellSignal: '넥라인 돌파에 실패하고 머리 저점을 재이탈하면 하락 지속 위험입니다.',
    mistake: '완성 전에 미리 진입하면 실패 시 손실이 커집니다. 넥라인 돌파 확인이 핵심입니다.',
    related: '거래량, 넥라인, 지지선. 손절은 오른쪽 어깨 저점 아래로 잡습니다. 돌파 시 거래량을 확인하세요.',
    pattern: 'invHeadShoulders',
  },
  {
    id: 'pattern-asc-triangle',
    group: '차트 패턴',
    title: '상승 삼각형',
    short: '수평 저항 + 저점 상승으로 수렴하는 강세형',
    concept:
      '상승 삼각형은 고점이 수평 저항선을 이루고 저점이 점점 높아지며 수렴하는 패턴으로, 상승 돌파 가능성이 높은 강세형입니다.',
    condition: '고점이 비슷한 수평 저항, 저점이 계속 높아지며 두 선이 수렴하고, 저항을 종가로 돌파할 때 완성됩니다.',
    interpretation: '매도세는 일정한데 매수세가 점점 강해지며 위로 눌리는 힘이 커짐을 뜻합니다.',
    buySignal: '수평 저항을 거래량 증가와 함께 돌파하면 상승 후보로 봅니다.',
    sellSignal: '저점 상승 추세선을 하향 이탈하면 패턴 실패 위험 신호입니다.',
    mistake: '수렴 후반부의 가짜 돌파가 잦습니다. 종가·거래량 확인이 필요합니다.',
    related: '거래량, 저항선, 추세선. 손절은 마지막 저점 아래로 잡습니다. 돌파 시 거래량 증가를 확인하세요.',
    pattern: 'ascTriangle',
  },
  {
    id: 'pattern-desc-triangle',
    group: '차트 패턴',
    title: '하락 삼각형',
    short: '수평 지지 + 고점 하락으로 수렴하는 약세형',
    concept:
      '하락 삼각형은 저점이 수평 지지선을 이루고 고점이 점점 낮아지며 수렴하는 패턴으로, 하락 이탈 가능성이 높은 약세형입니다.',
    condition: '저점이 비슷한 수평 지지, 고점이 계속 낮아지며 수렴하고, 지지를 종가로 이탈할 때 완성됩니다.',
    interpretation: '매수세는 일정한데 매도세가 점점 강해지며 아래로 눌리는 힘이 커짐을 뜻합니다.',
    buySignal: '이 패턴은 약세형이므로 매수 신호로 쓰지 않습니다.',
    sellSignal: '수평 지지를 거래량과 함께 이탈하면 하락 위험 신호로 봅니다.',
    mistake: '지지선에서 반등이 나올 수도 있어 이탈 확인 전 단정하면 안 됩니다.',
    related: '거래량, 지지선, 추세선. 손절은 마지막 고점 위로 잡습니다. 이탈 시 거래량을 확인하세요.',
    pattern: 'descTriangle',
  },
  {
    id: 'pattern-sym-triangle',
    group: '차트 패턴',
    title: '대칭 삼각형',
    short: '고점 하락·저점 상승으로 수렴하는 중립형',
    concept:
      '대칭 삼각형은 고점이 낮아지고 저점이 높아지며 대칭으로 수렴하는 패턴으로, 방향이 정해지기 전 에너지를 모으는 중립형입니다.',
    condition: '고점 하락 추세선과 저점 상승 추세선이 대칭으로 수렴하고, 한쪽을 종가로 돌파할 때 방향이 확정됩니다.',
    interpretation: '매수·매도 힘이 팽팽하다 한쪽으로 폭발하는 준비 구간입니다.',
    buySignal: '상단 추세선을 거래량과 함께 돌파하면 상승 후보로 봅니다.',
    sellSignal: '하단 추세선을 거래량과 함께 이탈하면 하락 위험 신호로 봅니다.',
    mistake: '수렴 꼭짓점에 가까울수록 가짜 돌파가 잦습니다. 돌파 방향을 확인 후 진입합니다.',
    related: '거래량, 추세선, 돌파. 손절은 반대 추세선 안쪽으로 잡습니다. 돌파 시 거래량 증가를 확인하세요.',
    pattern: 'symTriangle',
  },
  {
    id: 'pattern-bull-flag',
    group: '차트 패턴',
    title: '상승 깃발형',
    short: '급등(깃대) 후 완만한 조정 뒤 재상승',
    concept:
      '상승 깃발형은 강한 급등(깃대) 뒤 완만하게 눌리는 조정 채널(깃발)을 만들고 다시 상승하는 추세 지속 패턴입니다.',
    condition: '급등 후 3~10봉 완만한 조정 채널을 만들고, 채널 상단을 종가로 재돌파할 때 완성됩니다.',
    interpretation: '급등 후 잠시 쉬어가며 매물을 소화한 뒤 상승을 이어감을 뜻합니다.',
    buySignal: '조정 채널 상단을 거래량과 함께 재돌파하면 상승 지속 후보로 봅니다.',
    sellSignal: '조정이 깊어져 깃대 시작점 아래로 밀리면 패턴 실패 위험입니다.',
    mistake: '조정폭이 너무 크면 깃발형이 아닙니다. 조정은 얕고 완만해야 합니다.',
    related: '거래량, 추세선, 돌파. 손절은 조정 채널 하단 아래로 잡습니다. 재돌파 시 거래량 증가를 확인하세요.',
    pattern: 'bullFlag',
  },
  {
    id: 'pattern-bear-flag',
    group: '차트 패턴',
    title: '하락 깃발형',
    short: '급락(깃대) 후 완만한 되돌림 뒤 재하락',
    concept:
      '하락 깃발형은 강한 급락(깃대) 뒤 완만하게 되돌리는 채널(깃발)을 만들고 다시 하락하는 추세 지속 패턴입니다.',
    condition: '급락 후 완만한 되돌림 채널을 만들고, 채널 하단을 종가로 재이탈할 때 완성됩니다.',
    interpretation: '급락 후 잠시 되돌렸다 다시 하락을 이어감을 뜻합니다.',
    buySignal: '이 패턴은 하락 지속형이므로 매수 신호로 쓰지 않습니다.',
    sellSignal: '되돌림 채널 하단을 거래량과 함께 재이탈하면 하락 지속 위험 신호입니다.',
    mistake: '되돌림이 깃대 전체를 되돌리면 깃발형이 아닙니다. 되돌림은 얕아야 합니다.',
    related: '거래량, 추세선, 이탈. 손절은 되돌림 채널 상단 위로 잡습니다. 재이탈 시 거래량을 확인하세요.',
    pattern: 'bearFlag',
  },
  {
    id: 'pattern-rising-wedge',
    group: '차트 패턴',
    title: '상승 쐐기형',
    short: '고점·저점이 함께 오르며 수렴하는 하락 전환형',
    concept:
      '상승 쐐기형은 고점과 저점이 모두 상승하지만 저점이 더 가파르게 올라 수렴하는 패턴으로, 흔히 하락으로 전환됩니다.',
    condition: '고점·저점이 함께 상승하며 수렴하고, 하단 추세선을 종가로 이탈할 때 완성됩니다.',
    interpretation: '상승하지만 상승 폭이 점점 줄어 힘이 약해짐을 뜻합니다.',
    buySignal: '이 패턴은 하락 전환형이므로 매수 신호로 쓰지 않습니다.',
    sellSignal: '하단 추세선을 거래량과 함께 이탈하면 하락 전환 위험 신호로 봅니다.',
    mistake: '상승 중이라 강세로 오해하기 쉽습니다. 수렴과 하단 이탈을 확인해야 합니다.',
    related: '거래량, 추세선, RSI. 손절은 마지막 고점 위로 잡습니다. 이탈 시 거래량을 확인하세요.',
    pattern: 'risingWedge',
  },
  {
    id: 'pattern-falling-wedge',
    group: '차트 패턴',
    title: '하락 쐐기형',
    short: '고점·저점이 함께 내리며 수렴하는 상승 전환형',
    concept:
      '하락 쐐기형은 고점과 저점이 모두 하락하지만 고점이 더 가파르게 내려 수렴하는 패턴으로, 흔히 상승으로 전환됩니다.',
    condition: '고점·저점이 함께 하락하며 수렴하고, 상단 추세선을 종가로 돌파할 때 완성됩니다.',
    interpretation: '하락하지만 하락 폭이 점점 줄어 매도세가 약해짐을 뜻합니다.',
    buySignal: '상단 추세선을 거래량과 함께 돌파하면 상승 전환 후보로 봅니다.',
    sellSignal: '상단 돌파 실패 후 저점을 재이탈하면 하락 지속 위험입니다.',
    mistake: '하락 중이라 약세로 오해하기 쉽습니다. 수렴과 상단 돌파를 확인해야 합니다.',
    related: '거래량, 추세선, RSI. 손절은 마지막 저점 아래로 잡습니다. 돌파 시 거래량 증가를 확인하세요.',
    pattern: 'fallingWedge',
  },
  {
    id: 'pattern-cup-handle',
    group: '차트 패턴',
    title: '컵앤핸들',
    short: '완만한 U자 컵 + 얕은 손잡이 뒤 돌파',
    concept:
      '컵앤핸들은 완만한 U자형 바닥(컵)을 만든 뒤 우측에서 얕은 조정(손잡이)을 거치고 컵 테두리를 돌파하는 상승 지속형입니다.',
    condition: '완만한 U자 컵이 형성되고, 우측에서 얕은 손잡이 조정 뒤 컵 테두리(저항)를 종가로 돌파할 때 완성됩니다.',
    interpretation: '충분히 바닥을 다진 뒤 마지막 눌림을 소화하고 상승을 이어감을 뜻합니다.',
    buySignal: '컵 테두리를 거래량 증가와 함께 돌파하면 상승 후보로 봅니다.',
    sellSignal: '손잡이 조정이 깊어져 컵 절반 아래로 밀리면 패턴 실패 위험입니다.',
    mistake: '컵이 V자로 급하거나 손잡이가 너무 깊으면 신뢰도가 낮습니다.',
    related: '거래량, 저항선, 추세. 손절은 손잡이 저점 아래로 잡습니다. 돌파 시 거래량 증가를 확인하세요.',
    pattern: 'cupHandle',
  },
  {
    id: 'pattern-box',
    group: '차트 패턴',
    title: '박스권',
    short: '상단 저항·하단 지지 사이 횡보 구간',
    concept:
      '박스권은 뚜렷한 상단 저항선과 하단 지지선 사이에서 반복적으로 오르내리는 횡보 패턴입니다.',
    condition: '고점과 저점이 비슷한 가격대에서 반복되어 상·하단이 뚜렷할 때 성립합니다.',
    interpretation: '매수·매도 힘이 균형을 이룬 관망 상태로, 방향이 정해지기 전 구간입니다.',
    buySignal: '박스 하단 지지 확인 후 반등하거나 상단을 거래량과 함께 돌파할 때 접근을 고려합니다.',
    sellSignal: '박스 상단에서 막히거나 하단을 이탈하면 매도·관망 신호로 봅니다.',
    mistake: '상·하단마다 매매하면 가짜 돌파에 자주 당할 수 있습니다.',
    related: '지지선, 저항선, 거래량. 손절은 반대편 경계 밖으로 잡습니다. 돌파 시 거래량을 확인하세요.',
    pattern: 'box',
  },
  {
    id: 'pattern-box-break-up',
    group: '차트 패턴',
    title: '박스권 상단 돌파',
    short: '횡보 박스 상단을 종가로 뚫는 상승 전환',
    concept:
      '박스권 상단 돌파는 오래 횡보하던 박스의 상단 저항을 종가로 강하게 뚫고 올라가는 상승 전환 패턴입니다.',
    condition: '박스 상단 저항 위에서 종가가 마감되고 거래량이 평소보다 크게 늘 때 신뢰도가 높습니다.',
    interpretation: '매물대를 소화하고 새로운 상승 추세가 시작될 수 있음을 뜻합니다.',
    buySignal: '거래량 동반 종가 돌파 후 되돌림에서 지지받으면 상승 초입 후보로 봅니다.',
    sellSignal: '돌파 직후 종가가 다시 박스 안으로 밀리면 가짜 돌파 위험 신호입니다.',
    mistake: '장중 고가 돌파만 보고 진입하면 위험합니다. 종가·거래량을 확인해야 합니다.',
    related: '거래량, 저항선, 장대양봉. 손절은 박스 상단 아래로 잡습니다. 돌파 시 거래량 증가를 확인하세요.',
    pattern: 'boxBreakUp',
  },
  {
    id: 'pattern-box-break-down',
    group: '차트 패턴',
    title: '박스권 하단 이탈',
    short: '횡보 박스 하단을 종가로 깨는 하락 전환',
    concept:
      '박스권 하단 이탈은 오래 횡보하던 박스의 하단 지지를 종가로 깨고 내려가는 하락 전환 패턴입니다.',
    condition: '박스 하단 지지 아래에서 종가가 마감되고 거래량이 늘 때 신뢰도가 높습니다.',
    interpretation: '지지가 무너지며 추가 하락이 이어질 수 있음을 뜻합니다.',
    buySignal: '이 패턴은 하락 전환형이므로 매수 신호로 쓰지 않습니다.',
    sellSignal: '거래량 동반 종가 이탈이 확인되면 하락 위험 신호로 봅니다.',
    mistake: '장중 저가 이탈만 보고 공포 매도하면 저점에 팔 수 있습니다. 종가로 확인합니다.',
    related: '거래량, 지지선, 장대음봉. 손절은 박스 하단 위로 잡습니다. 이탈 시 거래량을 확인하세요.',
    pattern: 'boxBreakDown',
  },
  {
    id: 'pattern-rounding-bottom',
    group: '차트 패턴',
    title: '둥근 바닥',
    short: '완만한 U자로 서서히 바닥을 다지는 반전',
    concept:
      '둥근 바닥은 급락이나 급반등 없이 완만한 U자 곡선으로 서서히 바닥을 다지고 회복하는 장기 반전 패턴입니다.',
    condition: '저점이 완만한 곡선을 그리고 좌우가 비슷한 높이로 회복될 때 형성됩니다.',
    interpretation: '매도세가 서서히 소진되고 매수세가 점진적으로 유입됨을 뜻합니다.',
    buySignal: '이전 고점(테두리)을 거래량과 함께 돌파하면 상승 후보로 봅니다.',
    sellSignal: '회복 중 다시 바닥 아래로 밀리면 패턴 실패 위험 신호입니다.',
    mistake: '형성에 시간이 오래 걸립니다. 조급하게 진입하면 지루한 횡보에 지칠 수 있습니다.',
    related: '거래량, 지지선, 추세. 손절은 곡선 바닥 아래로 잡습니다. 회복·돌파 시 거래량을 확인하세요.',
    pattern: 'roundingBottom',
  },
  {
    id: 'pattern-v-recovery',
    group: '차트 패턴',
    title: 'V자 반등',
    short: '급락 직후 곧바로 급반등하는 날카로운 반전',
    concept:
      'V자 반등은 급락한 직후 되돌림 없이 곧바로 급반등하며 날카로운 V자를 그리는 반전 패턴입니다.',
    condition: '단기간 급락 후 곧바로 강한 반등이 나와 저점을 중심으로 V자를 형성할 때 성립합니다.',
    interpretation: '과도한 투매가 빠르게 해소되며 매수세가 급격히 유입됨을 뜻합니다.',
    buySignal: '급락 후 강한 반등 양봉과 거래량이 확인되면 단기 반등 후보로 봅니다.',
    sellSignal: '반등이 이전 저점 부근에서 다시 꺾이면 추가 하락 위험 신호입니다.',
    mistake: '떨어지는 칼날을 잡으려다 저점 확인 전 진입하면 크게 손실날 수 있습니다.',
    related: '거래량, 지지선, RSI. 손절은 V자 저점 아래로 잡습니다. 반등 시 거래량 증가를 확인하세요.',
    pattern: 'vRecovery',
  },
  {
    id: 'pattern-gap-up',
    group: '차트 패턴',
    title: '갭 상승',
    short: '전일 고가 위에서 크게 출발한 상승 빈 구간',
    concept:
      '갭 상승은 당일 시가·저가가 전일 고가보다 크게 높게 출발해 캔들 사이에 빈 구간이 생기는 강세 패턴입니다.',
    condition: '당일 저가가 전일 고가보다 높게 출발해 갭이 생길 때 성립합니다.',
    interpretation: '강한 호재나 수급으로 급격한 심리 변화가 있었음을 뜻합니다.',
    buySignal: '거래량 동반 갭이 눌림에도 메워지지 않고 지지되면 강세 지속 후보로 봅니다.',
    sellSignal: '갭이 당일 바로 메워지며 음봉으로 밀리면 소진성 갭 위험 신호입니다.',
    mistake: '모든 갭이 메워지는 것은 아닙니다. 갭 종류(돌파·소진)를 구분해야 합니다.',
    related: '거래량, 저항선, 공시·뉴스. 손절은 갭 하단 아래로 잡습니다. 갭 유지 시 거래량을 확인하세요.',
    pattern: 'gapUp',
  },
  {
    id: 'pattern-gap-down',
    group: '차트 패턴',
    title: '갭 하락',
    short: '전일 저가 아래에서 크게 출발한 하락 빈 구간',
    concept:
      '갭 하락은 당일 시가·고가가 전일 저가보다 크게 낮게 출발해 캔들 사이에 빈 구간이 생기는 약세 패턴입니다.',
    condition: '당일 고가가 전일 저가보다 낮게 출발해 갭이 생길 때 성립합니다.',
    interpretation: '강한 악재나 수급으로 급격한 심리 변화가 있었음을 뜻합니다.',
    buySignal: '과매도 구간에서 갭 하락 직후 강한 반등이 확인되면 바닥 여부를 함께 봅니다.',
    sellSignal: '갭 하락이 메워지지 못하고 추가 음봉이 나오면 하락 지속 위험 신호입니다.',
    mistake: '갭 하락에 공포 매도하면 저점에 팔 수 있습니다. 지지선·거래량을 함께 봅니다.',
    related: '거래량, 지지선, 공시·뉴스. 손절은 갭 상단 위로 잡습니다. 되돌림 시 거래량을 확인하세요.',
    pattern: 'gapDown',
  },
];

const GROUPS: StudyGroup[] = ['캔들', '차트 기초', '보조지표', '차트 패턴'];

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
            className="inline-flex items-center justify-center break-keep leading-tight rounded-xl border border-card-border bg-card px-3 py-2 text-center text-sm font-black text-muted-foreground"
          >
            정보
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center break-keep leading-tight rounded-xl border border-primary bg-primary px-3 py-2 text-center text-sm font-black text-primary-foreground"
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
  // 딥링크(?study=항목 제목) 지원 — 해당 항목의 실제 차트를 바로 연다. 기본 동작은 동일.
  const [chartOpen, setChartOpen] = useState(
    () => new URLSearchParams(window.location.search).get('study') === topic.title,
  );

  const chartConfig: StudyChartConfig = topic.pattern
    ? {
        title: topic.title,
        mode: 'pattern',
        patternKind: topic.pattern,
        showRsi: topic.showRsi,
        showMacd: topic.showMacd,
      }
    : {
        title: topic.title,
        mode: 'signal',
        signalKind: topic.detect,
        showRsi: topic.showRsi,
        showMacd: topic.showMacd,
      };

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

            <div className="rounded-2xl border border-card-border bg-background/70 p-3 text-center">
              <p className="mb-2 text-center text-sm font-extrabold text-primary">실제 차트 예시</p>
              <button
                type="button"
                onClick={() => setChartOpen(true)}
                className="mx-auto rounded-full bg-primary px-4 py-2 text-center text-sm font-black text-primary-foreground transition active:scale-[0.98]"
              >
                실제 차트 예시 보기
              </button>
            </div>
          </div>
        </div>
      )}

      {chartOpen && (
        <StudyChart config={chartConfig} onClose={() => setChartOpen(false)} />
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
