import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BookOpen,
  ChevronRight,
  GraduationCap,
  LineChart,
  Search,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { cn } from '@/lib/utils';

type AnyObj = Record<string, any>;

type StudyGroup =
  | '캔들·추세'
  | '차트 지표'
  | '매매 신호'
  | '재무제표'
  | '가치 지표'
  | '리스크 관리';

interface StudyTopic {
  id: string;
  group: StudyGroup;
  title: string;
  short: string;
  easy: string;
  when: string;
  danger: string;
  conditionTitle: string;
  indicators: string[];
  example: string;
}

interface RelatedStock {
  ticker: string;
  name: string;
  market: 'KR' | 'US';
  currency: 'KRW' | 'USD';
  price?: number | null;
  changePercent?: number | null;
  score?: number | null;
  matched?: string[];
}

const LIST_SCROLL_KEY = 'learn-page-scroll-top';

const TOPICS: StudyTopic[] = [
  {
    id: 'candlestick',
    group: '캔들·추세',
    title: '캔들 읽기',
    short: '시가·고가·저가·종가와 몸통·꼬리로 하루 힘을 읽는 방법',
    easy:
      '양봉은 종가가 시가보다 높고, 음봉은 종가가 시가보다 낮습니다. 몸통은 시가와 종가 사이, 위·아래 꼬리는 장중 고가와 저가를 보여줍니다.',
    when:
      '지지선에서 아래꼬리가 길게 생기거나 저항선에서 위꼬리가 길게 생길 때 매수·매도 힘의 충돌을 확인합니다.',
    danger:
      '캔들 하나만 보고 방향을 단정하면 위험합니다. 앞선 추세, 거래량, 지지·저항 위치를 함께 봐야 합니다.',
    conditionTitle: '거래량 동반 캔들 변화',
    indicators: ['거래량 증가', '단기 추세 전환', '돌파 직전'],
    example:
      '박스권 상단에서 거래량이 늘어난 장대양봉이 종가까지 유지되면 돌파 가능성을 확인합니다.',
  },
  {
    id: 'trend',
    group: '캔들·추세',
    title: '상승·하락·횡보 추세',
    short: '고점과 저점의 방향으로 현재 주가 흐름을 구분하는 기본 방법',
    easy:
      '고점과 저점이 계속 높아지면 상승 추세, 계속 낮아지면 하락 추세, 일정 범위 안에서 움직이면 횡보 추세입니다.',
    when:
      '매수 전 현재 추세를 먼저 구분하고 상승 추세의 눌림인지, 하락 추세의 일시 반등인지 판단할 때 사용합니다.',
    danger:
      '짧은 구간만 보면 큰 추세와 반대로 판단할 수 있습니다. 일봉과 주봉을 함께 확인해야 합니다.',
    conditionTitle: '추세 전환 후보',
    indicators: ['단기 추세 전환', '20일선 회복', '60일선 돌파'],
    example:
      '저점이 더 이상 낮아지지 않고 이전 고점을 돌파하면 하락 추세 종료 가능성을 확인합니다.',
  },
  {
    id: 'income-statement',
    group: '재무제표',
    title: '손익계산서',
    short: '매출·영업이익·순이익으로 회사가 실제 돈을 버는지 확인',
    easy:
      '매출은 판매 규모, 영업이익은 본업에서 남긴 이익, 순이익은 세금과 금융비용까지 반영한 최종 이익입니다.',
    when:
      '최근 여러 분기의 매출과 영업이익이 함께 증가하는지, 일회성 이익 없이 본업이 좋아지는지 확인합니다.',
    danger:
      '한 분기 급증만 보고 성장으로 단정하면 위험합니다. 전년 동기와 최근 3~4개 분기를 함께 봐야 합니다.',
    conditionTitle: '실적 개선 종목',
    indicators: ['ROE 개선', 'AI 점수 상위', '저평가'],
    example:
      '매출 증가율보다 영업이익 증가율이 더 크면 수익성이 개선되는 구간일 수 있습니다.',
  },
  {
    id: 'balance-sheet',
    group: '재무제표',
    title: '재무상태표',
    short: '자산·부채·자본으로 회사의 체력과 빚 부담을 확인',
    easy:
      '자산은 회사가 가진 것, 부채는 갚아야 할 것, 자본은 자산에서 부채를 뺀 주주의 몫입니다.',
    when:
      '현금이 충분한지, 단기 부채가 급증하지 않았는지, 자본이 계속 줄지 않는지 확인합니다.',
    danger:
      '자산이 많아도 현금화하기 어려운 자산이거나 부채가 더 빠르게 늘면 위험할 수 있습니다.',
    conditionTitle: '재무 안정 종목',
    indicators: ['저평가', 'PBR 낮음', 'AI 점수 상위'],
    example:
      '현금성 자산이 늘고 부채비율이 낮아지면서 이익도 증가하면 재무 체력이 좋아지는 흐름입니다.',
  },
  {
    id: 'cash-flow',
    group: '재무제표',
    title: '현금흐름표',
    short: '회계상 이익이 아니라 실제 현금이 들어오고 나가는 방향을 확인',
    easy:
      '영업현금흐름은 본업에서 들어온 현금, 투자현금흐름은 설비·투자 지출, 재무현금흐름은 차입·증자·배당 흐름입니다.',
    when:
      '순이익은 흑자인데 영업현금흐름이 계속 적자인지, 빚이나 증자로 운영비를 충당하는지 확인합니다.',
    danger:
      '순이익만 보고 현금 사정을 놓치면 위험합니다. 적자 현금흐름이 반복되면 추가 자금조달 가능성이 커집니다.',
    conditionTitle: '현금창출 개선 종목',
    indicators: ['ROE 개선', '저평가', 'AI 점수 상위'],
    example:
      '영업현금흐름이 꾸준히 플러스이고 투자 지출 후에도 현금이 남으면 재무 여력이 좋다고 볼 수 있습니다.',
  },
  {
    id: 'bollinger',
    group: '차트 지표',
    title: '볼린저밴드',
    short: '가격의 변동 범위를 위·아래 밴드로 보여주는 지표',
    easy:
      '볼린저밴드는 가격이 평균에서 얼마나 멀리 벗어났는지 보는 도구입니다. 위쪽 밴드에 가까우면 단기 과열, 아래쪽 밴드에 가까우면 단기 과매도 가능성을 봅니다.',
    when:
      '밴드가 좁아졌다가 다시 벌어지는 구간은 변동성이 커지는 시작점일 수 있습니다. 가격이 상단 밴드를 거래량과 함께 돌파하면 추세가 강해질 가능성을 봅니다.',
    danger:
      '밴드 상단에 닿았다고 무조건 매도, 하단에 닿았다고 무조건 매수하면 위험합니다. 강한 상승장에서는 상단 밴드를 타고 계속 오를 수 있고, 강한 하락장에서는 하단 밴드를 타고 계속 내려갈 수 있습니다.',
    conditionTitle: '볼린저밴드 수축/돌파',
    indicators: ['돌파 직전', '변동성 확대', '박스권 상단 돌파'],
    example:
      '가격이 좁은 박스권에서 움직이다가 거래량이 늘면서 상단 밴드를 돌파하면 단기 추세 전환 후보로 볼 수 있습니다.',
  },
  {
    id: 'rsi',
    group: '차트 지표',
    title: 'RSI',
    short: '최근 상승·하락 힘을 0~100으로 나타내는 과열·침체 지표',
    easy:
      'RSI는 최근 가격 상승 힘과 하락 힘을 비교해서 현재 주가가 과열인지 침체인지 보는 지표입니다. 보통 70 이상은 과열, 30 이하는 과매도 구간으로 봅니다.',
    when:
      'RSI가 30 아래에서 다시 올라오면서 가격도 지지선을 지키면 기술적 반등 후보가 될 수 있습니다. 반대로 70 이상에서 거래량 없이 밀리면 단기 조정 가능성을 봅니다.',
    danger:
      'RSI만 보고 매수하면 위험합니다. 하락 추세가 강하면 RSI가 낮아도 계속 떨어질 수 있습니다. 반드시 지지선, 거래량, 추세를 같이 확인해야 합니다.',
    conditionTitle: 'RSI 과매도 반등',
    indicators: ['RSI 과매도 반등', '낙폭과대', '지지선 반등'],
    example:
      'RSI가 30 근처까지 내려왔다가 다시 35~40 위로 회복하고, 동시에 주가가 이전 저점을 깨지 않으면 반등 가능성을 체크합니다.',
  },
  {
    id: 'macd',
    group: '차트 지표',
    title: 'MACD',
    short: '단기·장기 이동평균의 차이로 추세 전환을 잡는 지표',
    easy:
      'MACD는 단기 이동평균에서 장기 이동평균을 뺀 값과 그 평균선을 함께 봅니다. 두 선이 교차하는 지점에서 추세 변화를 읽습니다.',
    when:
      'MACD선이 시그널선을 아래에서 위로 뚫으면 매수 관점, 위에서 아래로 뚫으면 매도 관점으로 활용합니다. 막대가 커지는지도 같이 봅니다.',
    danger:
      '이동평균 기반이라 신호가 늦게 나옵니다. 횡보장에서는 교차 신호가 자주 어긋나 잦은 매매로 손실이 쌓일 수 있습니다.',
    conditionTitle: 'MACD 골든크로스',
    indicators: ['MACD 골든크로스', '단기 추세 전환', '이평선 돌파'],
    example:
      '가격이 바닥권에서 횡보한 뒤 MACD가 골든크로스를 만들고 거래량이 붙으면 추세 전환 후보로 볼 수 있습니다.',
  },
  {
    id: 'moving-average',
    group: '차트 지표',
    title: '이동평균선',
    short: '일정 기간 평균 가격을 이은 선으로 추세를 보는 기본 지표',
    easy:
      '이동평균선은 일정 기간 동안의 평균 가격입니다. 20일선은 단기, 60일선은 중기, 120일선은 장기 흐름을 보는 데 많이 씁니다.',
    when:
      '주가가 20일선을 회복하고 60일선까지 돌파하면 단기 추세 회복 가능성을 봅니다. 장기 하락 후 120일선을 회복하면 큰 추세 전환 후보가 될 수 있습니다.',
    danger:
      '이평선은 과거 가격 평균이라 항상 늦습니다. 돌파 직후 추격매수하면 눌림에 걸릴 수 있으니 거래량과 종가 유지 여부를 같이 봐야 합니다.',
    conditionTitle: '이평선 회복/돌파',
    indicators: ['이평선 돌파', '20일선 회복', '60일선 돌파', '120일선 돌파'],
    example:
      '20일선 위로 올라온 뒤 다시 20일선 근처에서 지지를 받으면 눌림목 진입 후보로 볼 수 있습니다.',
  },
  {
    id: 'volume',
    group: '차트 지표',
    title: '거래량',
    short: '얼마나 많은 주식이 사고팔렸는지 보여주는 힘의 크기',
    easy:
      '거래량은 시장 참여자의 관심과 돈의 유입을 보여줍니다. 가격 상승과 거래량 증가가 같이 나오면 상승의 신뢰도가 높아집니다.',
    when:
      '박스권 돌파, 이평선 돌파, 신고가 돌파 시 거래량이 함께 증가하면 신뢰도가 올라갑니다. 반대로 거래량 없는 상승은 힘이 약할 수 있습니다.',
    danger:
      '거래량이 많아도 윗꼬리가 길게 남고 종가가 밀리면 세력이 털고 나간 흔적일 수 있습니다. 캔들 모양과 종가 위치를 반드시 같이 봐야 합니다.',
    conditionTitle: '거래량 증가',
    indicators: ['거래량 증가', '거래량 급증', '거래대금 증가'],
    example:
      '평소보다 거래량이 2배 이상 늘면서 이전 고점을 돌파하면 관심종목으로 올려볼 수 있습니다.',
  },
  {
    id: 'golden-cross',
    group: '매매 신호',
    title: '골든크로스',
    short: '단기 이동평균선이 장기 이동평균선을 위로 돌파하는 신호',
    easy:
      '골든크로스는 짧은 기간 평균 가격이 긴 기간 평균 가격을 위로 뚫는 현상입니다. 하락하던 흐름이 상승으로 바뀔 가능성을 봅니다.',
    when:
      '20일선이 60일선을 돌파하거나 MACD가 골든크로스를 만들 때 거래량이 같이 붙으면 더 의미가 있습니다.',
    danger:
      '횡보장에서는 골든크로스가 나와도 바로 다시 꺾이는 경우가 많습니다. 돌파 후 지지 여부를 확인해야 합니다.',
    conditionTitle: '골든크로스 조건',
    indicators: ['MACD 골든크로스', '이평선 돌파', '단기 추세 전환'],
    example:
      '주가가 바닥권에서 횡보하다가 20일선과 60일선을 회복하며 거래량이 증가하면 골든크로스 후보로 볼 수 있습니다.',
  },
  {
    id: 'breakout',
    group: '매매 신호',
    title: '캔들 돌파',
    short: '저항선을 강한 캔들로 뚫고 올라가는 신호',
    easy:
      '캔들 돌파는 이전에 계속 막히던 가격대를 강한 양봉으로 뚫는 모습입니다. 매물대를 뚫었다는 의미로 해석합니다.',
    when:
      '이전 고점, 박스권 상단, 장기 이평선 같은 저항선을 거래량과 함께 돌파할 때 의미가 커집니다.',
    danger:
      '돌파한 척하다가 다시 저항선 아래로 밀리는 가짜 돌파가 많습니다. 종가가 저항선 위에서 마감되는지 확인해야 합니다.',
    conditionTitle: '저항선 돌파',
    indicators: ['저항선 돌파', '박스권 상단 돌파', '돌파 직전'],
    example:
      '여러 번 막히던 가격대를 거래량 동반 장대양봉으로 넘고 종가가 위에서 끝나면 돌파 신뢰도가 높아집니다.',
  },
  {
    id: 'pullback',
    group: '매매 신호',
    title: '눌림목',
    short: '상승 중 잠깐 쉬어가는 조정 구간',
    easy:
      '눌림목은 상승하던 주가가 잠시 조정받는 자리입니다. 추세가 살아있다면 이 구간이 분할 진입 후보가 됩니다.',
    when:
      '20일선, 이전 저항선이 지지선으로 바뀐 자리, 박스권 상단 재확인 자리에서 반등이 나오면 눌림목으로 볼 수 있습니다.',
    danger:
      '눌림목이라고 생각했는데 실제로는 추세가 무너지는 시작일 수 있습니다. 손절 기준을 먼저 정해야 합니다.',
    conditionTitle: '눌림목 조건',
    indicators: ['눌림목', '지지선 반등', '20일선 회복'],
    example:
      '돌파 후 주가가 다시 20일선 근처까지 내려왔지만 거래량이 줄고 지지를 받으면 눌림목 후보입니다.',
  },
  {
    id: 'support-resistance',
    group: '매매 신호',
    title: '지지선/저항선',
    short: '주가가 자주 멈추거나 튕기는 가격대',
    easy:
      '지지선은 주가가 내려오다 멈추는 가격대, 저항선은 올라가다 막히는 가격대입니다. 매수·매도 기준을 잡는 데 중요합니다.',
    when:
      '지지선 근처에서는 손절폭을 짧게 잡고 반등을 노릴 수 있고, 저항선을 돌파하면 상승 추세 전환 가능성을 봅니다.',
    danger:
      '지지선은 절대선이 아닙니다. 깨지면 빠르게 하락할 수 있어 손절 기준을 반드시 정해야 합니다.',
    conditionTitle: '지지/저항 조건',
    indicators: ['지지선 반등', '저항선 돌파', '박스권 하단'],
    example:
      '여러 번 반등했던 가격대를 다시 지키면 지지선 반등 후보, 여러 번 막혔던 가격을 뚫으면 저항선 돌파 후보입니다.',
  },
  {
    id: 'per',
    group: '가치 지표',
    title: 'PER',
    short: '이익 대비 주가가 비싼지 싼지 보는 지표',
    easy:
      'PER은 주가를 주당순이익으로 나눈 값입니다. 낮으면 이익 대비 싸다고 볼 수 있지만, 성장성이 낮거나 실적이 꺾이면 낮은 PER도 위험할 수 있습니다.',
    when:
      '안정적으로 이익을 내는 기업이 업종 평균보다 PER이 낮고 실적이 유지된다면 저평가 후보로 볼 수 있습니다.',
    danger:
      '일회성 이익 때문에 PER이 낮아진 경우가 있습니다. 영업이익과 순이익이 지속 가능한지 확인해야 합니다.',
    conditionTitle: 'PER 낮음',
    indicators: ['PER 낮음', '저평가', 'AI 점수 상위'],
    example:
      'PER이 낮은데 매출과 이익이 꾸준히 증가하고 부채가 낮다면 저평가 후보로 봅니다.',
  },
  {
    id: 'pbr',
    group: '가치 지표',
    title: 'PBR',
    short: '자산 대비 주가가 비싼지 싼지 보는 지표',
    easy:
      'PBR은 주가를 주당순자산으로 나눈 값입니다. 1배 이하면 장부상 자산보다 낮게 거래된다는 뜻입니다.',
    when:
      '자산가치가 중요하고 부채가 낮은 기업이 PBR 1배 근처라면 저평가 후보로 볼 수 있습니다.',
    danger:
      'PBR이 낮아도 자산의 질이 나쁘거나 계속 적자를 내면 싸다고 보기 어렵습니다.',
    conditionTitle: 'PBR 낮음',
    indicators: ['PBR 낮음', '저평가', '재무 확인'],
    example:
      'PBR이 낮고 부채비율이 안정적이며 흑자를 유지하는 기업은 가치주 후보로 볼 수 있습니다.',
  },
  {
    id: 'roe',
    group: '가치 지표',
    title: 'ROE',
    short: '자본으로 얼마나 이익을 잘 내는지 보는 지표',
    easy:
      'ROE는 자기자본 대비 순이익 비율입니다. 기업이 가진 자본을 얼마나 효율적으로 굴리는지 보여줍니다.',
    when:
      'ROE가 꾸준히 높고 부채비율이 과하지 않다면 좋은 기업일 가능성이 높습니다.',
    danger:
      '부채를 많이 써서 ROE가 높아진 경우도 있습니다. 부채비율과 함께 봐야 합니다.',
    conditionTitle: 'ROE 개선',
    indicators: ['ROE 개선', 'AI 점수 상위', '저평가'],
    example:
      'ROE가 15% 이상이고 매출과 이익이 함께 증가하면 우량 성장주 후보로 볼 수 있습니다.',
  },
  {
    id: 'debt',
    group: '리스크 관리',
    title: '부채비율',
    short: '자본 대비 부채가 얼마나 많은지 보는 안정성 지표',
    easy:
      '부채비율은 기업이 가진 자본에 비해 빚이 얼마나 많은지 보는 지표입니다. 낮을수록 재무 안정성이 높습니다.',
    when:
      '부채비율이 100% 이하이면 비교적 안정적으로 보고, 200% 이상이면 업종 특성을 감안해도 주의가 필요합니다.',
    danger:
      '부채비율만 낮아도 적자가 계속되면 위험합니다. 현금흐름과 이익을 같이 봐야 합니다.',
    conditionTitle: '재무 안정 조건',
    indicators: ['AI 점수 상위', '저평가', 'ROE 개선'],
    example:
      '부채비율이 낮고 영업이익이 흑자인 기업은 하락장에서도 버틸 가능성이 높습니다.',
  },
  {
    id: 'dilution',
    group: '리스크 관리',
    title: '유상증자/희석',
    short: '새 주식 발행으로 기존 주주 가치가 줄어드는 리스크',
    easy:
      '희석은 회사가 새 주식을 발행해서 기존 주주의 지분 가치가 줄어드는 현상입니다. 유상증자, 오퍼링, ATM, 전환사채 등이 원인이 됩니다.',
    when:
      '자금 조달이 성장 투자로 이어질 수도 있지만, 적자 보전이나 운영비 확보 목적이면 주가에 부담이 될 수 있습니다.',
    danger:
      '반복적인 희석은 주가가 오르기 어려운 큰 이유가 됩니다. 특히 소형주, 적자기업, 바이오·스팩류에서 조심해야 합니다.',
    conditionTitle: '희석 리스크 확인',
    indicators: ['변동성 확대', '공시 호재', '거래량 급증'],
    example:
      '급등 후 유상증자나 ATM 공시가 나오면 기존 주주에게 희석 부담이 생길 수 있습니다.',
  },
  {
    id: 'delisting',
    group: '리스크 관리',
    title: '상장폐지 주의',
    short: '거래정지·관리종목·상장유지 요건 미달 리스크',
    easy:
      '상장폐지 주의는 회사가 거래소 기준을 충족하지 못하거나 재무·감사의견 문제가 생겼을 때 봐야 하는 리스크입니다.',
    when:
      '관리종목, 거래정지, 감사의견 거절, 나스닥 최저가 요건 미달 같은 공시가 나오면 반드시 원문을 확인해야 합니다.',
    danger:
      '상장폐지 리스크가 있는 종목은 반등이 커 보여도 손실 위험이 매우 큽니다. 단기 매매라도 손절 기준이 없으면 위험합니다.',
    conditionTitle: '상장 리스크 확인',
    indicators: ['변동성 확대', '급락', '공시 확인'],
    example:
      '주가가 싸다고 느껴져도 상장유지 요건 문제가 있으면 단순 저가 매수가 아니라 고위험 투기일 수 있습니다.',
  },
];

const GROUPS: StudyGroup[] = [
  '캔들·추세',
  '차트 지표',
  '매매 신호',
  '재무제표',
  '가치 지표',
  '리스크 관리',
];

function currentBasePath() {
  const path = window.location.pathname;

  if (path.startsWith('/study')) return '/study';

  return '/learn';
}

function topicFromUrl() {
  return new URLSearchParams(window.location.search).get('topic');
}

function saveScroll(value: number) {
  window.sessionStorage.setItem(LIST_SCROLL_KEY, String(value));
}

function readScroll() {
  const value = Number(window.sessionStorage.getItem(LIST_SCROLL_KEY) ?? 0);

  return Number.isFinite(value) ? value : 0;
}

async function fetchRelatedStocks(indicators: string[]): Promise<RelatedStock[]> {
  if (!indicators.length) return [];

  const url = `/api/market/scan?market=KR&indicators=${encodeURIComponent(
    indicators.join(','),
  )}`;

  const res = await fetch(url);

  if (!res.ok) return [];

  const data = (await res.json()) as { cards?: AnyObj[] };

  return (data.cards ?? []).slice(0, 8).map((card) => ({
    ticker: String(card.ticker ?? ''),
    name: String(card.name ?? card.ticker ?? ''),
    market: card.market === 'US' ? 'US' : 'KR',
    currency: card.currency === 'USD' ? 'USD' : 'KRW',
    price:
      typeof card.price === 'number' && Number.isFinite(card.price)
        ? card.price
        : null,
    changePercent:
      typeof card.changePercent === 'number' && Number.isFinite(card.changePercent)
        ? card.changePercent
        : null,
    score:
      typeof card.score === 'number' && Number.isFinite(card.score)
        ? card.score
        : null,
    matched: Array.isArray(card.matched) ? card.matched.map(String) : [],
  }));
}

function formatPrice(value: number | null | undefined, currency: 'KRW' | 'USD') {
  if (value == null || !Number.isFinite(value)) return '확인중';

  if (currency === 'USD') {
    return `$${value.toLocaleString(undefined, {
      maximumFractionDigits: value >= 100 ? 2 : 4,
    })}`;
  }

  return `${Math.round(value).toLocaleString()}원`;
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '0.00%';

  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export default function LearnPage() {
  const [, navigate] = useLocation();
  const listRef = useRef<HTMLElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const id = topicFromUrl();

    return TOPICS.some((topic) => topic.id === id) ? id : null;
  });

  const selected = useMemo(
    () => TOPICS.find((topic) => topic.id === selectedId) ?? null,
    [selectedId],
  );

  const related = useQuery({
    queryKey: ['learn-related-stocks', selected?.id],
    queryFn: () => fetchRelatedStocks(selected?.indicators ?? []),
    enabled: Boolean(selected),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const restoreListScroll = useCallback(() => {
    const top = readScroll();

    window.setTimeout(() => {
      if (listRef.current) {
        listRef.current.scrollTop = top;
      }
    }, 50);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const id = topicFromUrl();
      const valid = TOPICS.some((topic) => topic.id === id);

      setSelectedId(valid ? id : null);

      if (!valid) {
        restoreListScroll();
      }
    };

    window.addEventListener('popstate', onPopState);

    return () => window.removeEventListener('popstate', onPopState);
  }, [restoreListScroll]);

  useEffect(() => {
    if (!selectedId) {
      restoreListScroll();
    }
  }, [selectedId, restoreListScroll]);

  const openTopic = (topic: StudyTopic) => {
    saveScroll(listRef.current?.scrollTop ?? 0);

    const base = currentBasePath();
    const nextUrl = `${base}?topic=${encodeURIComponent(topic.id)}`;

    window.history.pushState(
      {
        fromLearnList: true,
        learnTopic: topic.id,
      },
      '',
      nextUrl,
    );

    setSelectedId(topic.id);
  };

  const closeTopic = () => {
    const state = window.history.state as
      | {
          fromLearnList?: boolean;
        }
      | null
      | undefined;

    if (state?.fromLearnList) {
      window.history.back();
      return;
    }

    const base = currentBasePath();

    window.history.replaceState({}, '', base);
    setSelectedId(null);
    restoreListScroll();
  };

  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <header className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-4 pb-4 pt-5 glass">
          <div className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-3">
            <button
              type="button"
              onClick={closeTopic}
              className="flex h-12 w-12 items-center justify-center rounded-full border border-card-border bg-card text-muted-foreground"
            >
              <ArrowLeft className="h-6 w-6" />
            </button>

            <div className="min-w-0">
              <h1 className="truncate text-2xl font-extrabold">
                {selected.title}
              </h1>

              <p className="mt-1 text-sm font-bold text-muted-foreground">
                {selected.group}
              </p>
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-24 pt-4">
          <div className="space-y-4">
            <StudyCard title="쉬운 설명">
              <p className="break-keep text-base font-semibold leading-loose text-foreground">
                {selected.easy}
              </p>
            </StudyCard>

            <StudyCard title="언제 쓰나요">
              <p className="break-keep text-base font-semibold leading-loose text-foreground">
                {selected.when}
              </p>
            </StudyCard>

            <StudyCard title="실전 예시">
              <p className="break-keep text-base font-semibold leading-loose text-foreground">
                {selected.example}
              </p>
            </StudyCard>

            <StudyCard title="잘못 쓰면 위험한 점">
              <div className="flex gap-3">
                <AlertTriangle className="mt-1 h-5 w-5 shrink-0 text-destructive" />

                <p className="break-keep text-base font-semibold leading-loose text-destructive">
                  {selected.danger}
                </p>
              </div>
            </StudyCard>

            <StudyCard title="조건에 맞는 관련 종목">
              <p className="break-keep text-sm font-semibold leading-relaxed text-muted-foreground">
                아래 종목은 “{selected.conditionTitle}” 조건에 맞는 후보입니다.
                단독 매수 신호가 아니라 공부용 예시로 확인하세요.
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                {selected.indicators.map((indicator) => (
                  <span
                    key={indicator}
                    className="rounded-full bg-primary/10 px-3 py-1.5 text-xs font-extrabold text-primary"
                  >
                    {indicator}
                  </span>
                ))}
              </div>

              {related.isLoading && (
                <div className="mt-4 rounded-2xl bg-secondary/70 p-4 text-center">
                  <p className="text-sm font-bold text-muted-foreground">
                    관련 종목을 불러오는 중...
                  </p>
                </div>
              )}

              {!related.isLoading && (related.data ?? []).length === 0 && (
                <div className="mt-4 rounded-2xl bg-secondary/70 p-4 text-center">
                  <p className="break-keep text-sm font-bold leading-relaxed text-muted-foreground">
                    현재 조건에 맞는 관련 종목이 없습니다.
                  </p>
                </div>
              )}

              <div className="mt-4 grid grid-cols-1 gap-2">
                {(related.data ?? []).map((stock) => (
                  <button
                    key={`${stock.market}:${stock.ticker}`}
                    type="button"
                    onClick={() => {
                      const back = `${currentBasePath()}?topic=${selected.id}`;

                      const tab =
                        selected.group === '재무제표' ||
                        selected.group === '가치 지표'
                          ? 'financials'
                          : 'chart';

                      navigate(
                        `/stock/${stock.ticker}?tab=${tab}&study=${encodeURIComponent(
                          selected.id,
                        )}&back=${encodeURIComponent(back)}`,
                      );
                    }}
                    className="rounded-2xl border border-card-border bg-background/80 p-3 text-left transition active:scale-[0.99]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-extrabold">
                          {stock.name}
                        </p>

                        <p className="mt-1 text-xs font-bold text-muted-foreground">
                          {stock.market === 'US'
                            ? `티커 ${stock.ticker}`
                            : stock.ticker}
                        </p>
                      </div>

                      <div className="shrink-0 text-right">
                        <p className="text-sm font-extrabold">
                          {formatPrice(stock.price, stock.currency)}
                        </p>

                        <p
                          className={cn(
                            'mt-1 text-xs font-extrabold',
                            (stock.changePercent ?? 0) >= 0
                              ? 'text-positive'
                              : 'text-destructive',
                          )}
                        >
                          {formatPercent(stock.changePercent)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(stock.matched ?? []).slice(0, 4).map((item) => (
                        <span
                          key={item}
                          className="rounded-full bg-secondary px-2 py-1 text-[11px] font-bold text-muted-foreground"
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </StudyCard>
          </div>
        </main>

        <BottomNav />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-4 pb-4 pt-5 text-center glass">
        <h1 className="text-2xl font-extrabold">공부</h1>
      </header>

      <main
        ref={listRef}
        onScroll={(event) => {
          saveScroll(event.currentTarget.scrollTop);
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-24 pt-4"
      >
        <div className="space-y-6">
          {GROUPS.map((group) => {
            const topics = TOPICS.filter((topic) => topic.group === group);

            return (
              <section key={group}>
                <h2 className="mb-3 text-lg font-extrabold text-muted-foreground">
                  {group}
                </h2>

                <div className="space-y-3">
                  {topics.map((topic) => (
                    <StudyTopicButton
                      key={topic.id}
                      topic={topic}
                      onClick={() => openTopic(topic)}
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

function StudyTopicButton({
  topic,
  onClick,
}: {
  topic: StudyTopic;
  onClick: () => void;
}) {
  const Icon = iconForGroup(topic.group);

  return (
    <button
      type="button"
      onClick={onClick}
      className="grid w-full grid-cols-[72px_minmax(0,1fr)_24px] items-center gap-3 rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm transition active:scale-[0.99]"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Icon className="h-7 w-7" />
      </div>

      <div className="min-w-0">
        <p className="text-lg font-extrabold">{topic.title}</p>

        <p className="mt-1 break-keep text-sm font-semibold leading-relaxed text-muted-foreground">
          {topic.short}
        </p>
      </div>

      <ChevronRight className="h-5 w-5 text-muted-foreground" />
    </button>
  );
}

function StudyCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-card-border bg-card p-5 shadow-sm">
      <h2 className="mb-4 text-lg font-extrabold">{title}</h2>

      {children}
    </section>
  );
}

function iconForGroup(group: StudyGroup) {
  if (group === '캔들·추세') return LineChart;
  if (group === '차트 지표') return GraduationCap;
  if (group === '매매 신호') return TrendingUp;
  if (group === '재무제표') return BookOpen;
  if (group === '가치 지표') return BarChart3;
  if (group === '리스크 관리') return ShieldAlert;

  return BookOpen;
}

