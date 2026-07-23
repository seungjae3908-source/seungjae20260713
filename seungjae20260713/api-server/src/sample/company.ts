// Company profile sample data. Curated details for well-known names + a
// keyword classifier that produces plausible industry/sector/competitors for
// the rest. API-ready: a real profile provider can replace `getCompanyProfile`.
import { CATALOG, getCatalogEntry, type CatalogEntry } from '../data/catalog';
import { seeded, pick } from './rng';
import type { CompanyProfile } from './types';

interface SectorInfo {
  industry: string;
  business: string;
}

const SECTORS: Record<string, SectorInfo> = {
  반도체: { industry: '반도체 및 장비', business: '반도체 설계·제조 및 관련 장비 공급' },
  'IT·소프트웨어': { industry: '소프트웨어·클라우드', business: '소프트웨어 및 클라우드 서비스 개발' },
  '인터넷·플랫폼': { industry: '인터넷 서비스', business: '온라인 플랫폼 및 디지털 광고 사업' },
  '전기차·자동차': { industry: '자동차·부품', business: '완성차 및 자동차 부품 제조' },
  '2차전지': { industry: '2차전지·소재', business: '전기차용 배터리 및 소재 생산' },
  '바이오·제약': { industry: '제약·바이오', business: '의약품 연구개발 및 위탁생산' },
  금융: { industry: '은행·보험', business: '은행, 보험 및 자산운용 서비스' },
  에너지: { industry: '에너지·화학', business: '석유화학 및 에너지 사업' },
  소비재: { industry: '소비재·유통', business: '소비재 제조 및 유통' },
  통신: { industry: '통신 서비스', business: '이동통신 및 네트워크 서비스' },
  산업재: { industry: '산업재·건설', business: '건설 및 산업 설비 사업' },
  엔터테인먼트: { industry: '미디어·엔터', business: '콘텐츠 제작 및 엔터테인먼트 사업' },
  양자컴퓨팅: { industry: '양자컴퓨팅', business: '양자컴퓨팅 하드웨어 및 클라우드 개발' },
  기타: { industry: '복합 산업', business: '다각화된 사업' },
};

type SectorKey = keyof typeof SECTORS;

// Ordered keyword rules (matched against lower-cased english + korean name).
const RULES: { kw: string[]; sector: SectorKey }[] = [
  { kw: ['quantum', 'rigetti', 'ionq'], sector: '양자컴퓨팅' },
  {
    kw: ['semiconductor', 'nvidia', 'amd', 'advanced micro', 'intel', 'qualcomm', 'broadcom', 'micron', 'asml', 'marvell', 'microchip', 'analog devices', 'texas instruments', 'arm', 'tsmc', 'hynix', '하이닉스', '반도체', '전기', 'sk하이닉스', '이노텍'],
    sector: '반도체',
  },
  { kw: ['battery', '에너지솔루션', 'sdi', '엔솔', '2차전지', '퓨처엠', '엘앤에프'], sector: '2차전지' },
  {
    kw: ['bio', 'pharma', 'therapeutics', 'biologics', 'genomics', '바이오', '제약', '셀트리온', '바이오로직스', '메디'],
    sector: '바이오·제약',
  },
  {
    kw: ['motor', 'automotive', 'tesla', 'rivian', 'lucid', '현대차', '기아', '모비스', '자동차'],
    sector: '전기차·자동차',
  },
  {
    kw: ['bank', 'financial', 'insurance', '금융', '지주', '은행', '생명', '화재', '증권', '카드'],
    sector: '금융',
  },
  {
    kw: ['software', 'cloud', 'oracle', 'salesforce', 'adobe', 'servicenow', 'snowflake', 'palantir', 'sap', 'crowdstrike', 'datadog', '에스디에스', '소프트'],
    sector: 'IT·소프트웨어',
  },
  {
    kw: ['internet', 'meta', 'alphabet', 'google', 'amazon', 'netflix', 'naver', 'kakao', '네이버', '카카오', '쿠팡'],
    sector: '인터넷·플랫폼',
  },
  {
    kw: ['game', 'entertainment', 'ent', '엔씨', '넷마블', '펄어비스', '하이브', '에스엠', '와이지', 'jyp', '게임즈', '엔터'],
    sector: '엔터테인먼트',
  },
  {
    kw: ['energy', 'oil', 'chemical', 'posco', 'holdings', '화학', '이노베이션', 's-oil', '전력', '정유', '케미칼'],
    sector: '에너지',
  },
  { kw: ['telecom', '텔레콤', 'kt', '유플러스', 'lg유플러스'], sector: '통신' },
  {
    kw: ['construction', '건설', '물산', 'gs', '중공업', '엔지니어링'],
    sector: '산업재',
  },
  {
    kw: ['retail', 'food', 'beverage', '제일제당', '농심', '오리온', '이마트', '리테일', '백화점', '생활건강', '퍼시픽', '하이트', '진로', '제과'],
    sector: '소비재',
  },
];

function classify(entry: CatalogEntry): SectorKey {
  const hay = `${entry.name} ${entry.ticker}`.toLowerCase();
  for (const rule of RULES) {
    if (rule.kw.some((k) => hay.includes(k.toLowerCase()))) return rule.sector;
  }
  return '기타';
}

// Lazy sector -> peer-names index for competitor generation.
let peerIndex: Map<SectorKey, string[]> | null = null;
function peersFor(entry: CatalogEntry, sector: SectorKey): string[] {
  if (!peerIndex) {
    peerIndex = new Map();
    for (const e of CATALOG) {
      const s = classify(e);
      const list = peerIndex.get(s) ?? [];
      list.push(e.name);
      peerIndex.set(s, list);
    }
  }
  const list = (peerIndex.get(sector) ?? []).filter((n) => n !== entry.name);
  const r = seeded(entry.ticker, 'peers');
  const out: string[] = [];
  const pool = [...list];
  while (out.length < 3 && pool.length > 0) {
    const idx = Math.floor(r() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

// Curated overrides for headline names (accurate competitors + descriptions).
const CURATED: Record<string, Partial<CompanyProfile>> = {
  '005930': { sector: '반도체', industry: '반도체·전자', mainBusiness: '메모리 반도체, 스마트폰, 디스플레이, 가전 사업', competitors: ['SK하이닉스', 'TSMC', 'Apple'], description: '삼성전자는 메모리 반도체와 스마트폰(갤럭시), 디스플레이, 가전을 아우르는 글로벌 종합 전자·IT 기업입니다.' },
  '000660': { sector: '반도체', industry: '메모리 반도체', mainBusiness: 'DRAM·NAND 등 메모리 반도체 제조', competitors: ['삼성전자', 'Micron', 'TSMC'], description: 'SK하이닉스는 DRAM과 NAND 플래시를 중심으로 한 세계적인 메모리 반도체 전문 기업입니다.' },
  '005380': { sector: '전기차·자동차', industry: '완성차', mainBusiness: '내연기관·전기차 완성차 제조 및 판매', competitors: ['기아', 'Tesla', 'Toyota'], description: '현대차는 승용·상용차와 전기차를 생산하는 대한민국 대표 완성차 기업입니다.' },
  '035420': { sector: '인터넷·플랫폼', industry: '인터넷 서비스', mainBusiness: '검색 포털, 커머스, 핀테크, 클라우드', competitors: ['카카오', 'Google', '쿠팡'], description: 'NAVER는 검색 포털을 기반으로 커머스·핀테크·클라우드·콘텐츠로 확장한 대표 인터넷 기업입니다.' },
  '035720': { sector: '인터넷·플랫폼', industry: '모바일 플랫폼', mainBusiness: '메신저, 핀테크, 모빌리티, 콘텐츠', competitors: ['NAVER', 'Google', '쿠팡'], description: '카카오는 국민 메신저 카카오톡을 기반으로 핀테크·모빌리티·콘텐츠 사업을 운영합니다.' },
  AAPL: { sector: 'IT·소프트웨어', industry: '소비자 전자기기', mainBusiness: 'iPhone, Mac, 서비스 생태계', competitors: ['삼성전자', 'Microsoft', 'Google'], description: 'Apple은 iPhone, Mac, iPad와 서비스 생태계를 보유한 세계 최대 소비자 전자·IT 기업입니다.' },
  MSFT: { sector: 'IT·소프트웨어', industry: '소프트웨어·클라우드', mainBusiness: 'Windows, Office, Azure 클라우드', competitors: ['Apple', 'Google', 'Amazon'], description: 'Microsoft는 Windows·Office와 Azure 클라우드를 중심으로 한 글로벌 소프트웨어 기업입니다.' },
  NVDA: { sector: '반도체', industry: 'GPU·AI 반도체', mainBusiness: 'AI·그래픽 GPU 설계', competitors: ['AMD', 'Intel', 'Qualcomm'], description: 'NVIDIA는 AI 및 그래픽 처리를 위한 GPU를 설계하는 세계적인 반도체 기업입니다.' },
  TSLA: { sector: '전기차·자동차', industry: '전기차', mainBusiness: '전기차 및 에너지 저장장치 제조', competitors: ['현대차', 'BYD', 'Rivian'], description: 'Tesla는 전기차와 에너지 저장장치, 자율주행 기술을 개발하는 선도 전기차 기업입니다.' },
  RGTI: { sector: '양자컴퓨팅', industry: '양자컴퓨팅', mainBusiness: '초전도 양자컴퓨터 및 클라우드', competitors: ['IonQ', 'D-Wave', 'IBM'], description: 'Rigetti Computing은 초전도 방식의 양자컴퓨터와 클라우드 접근을 제공하는 양자컴퓨팅 기업입니다.' },
  AMD: { sector: '반도체', industry: 'CPU·GPU', mainBusiness: 'CPU·GPU 반도체 설계', competitors: ['Intel', 'NVIDIA', 'Qualcomm'], description: 'AMD는 CPU와 GPU를 설계하는 글로벌 팹리스 반도체 기업입니다.' },
};

export function getCompanyProfile(ticker: string): CompanyProfile | null {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  const sector = (CURATED[entry.ticker]?.sector as SectorKey) ?? classify(entry);
  const info = SECTORS[sector] ?? SECTORS['기타'];
  const country = entry.market === 'KR' ? '대한민국' : '미국';
  const curated = CURATED[entry.ticker] ?? {};
  const competitors = curated.competitors ?? peersFor(entry, sector);
  const industry = curated.industry ?? info.industry;
  const mainBusiness = curated.mainBusiness ?? info.business;
  const description =
    curated.description ??
    `${entry.name}은(는) ${country}의 ${sector} 기업으로, ${mainBusiness}을 영위하고 있습니다.`;

  return {
    ticker: entry.ticker,
    name: entry.name,
    market: entry.market,
    currency: entry.currency,
    description,
    industry,
    sector,
    country,
    mainBusiness,
    competitors,
  };
}

// exported for other generators that want a stable sector for a ticker
export function sectorOf(entry: CatalogEntry): string {
  return (CURATED[entry.ticker]?.sector as string) ?? classify(entry);
}

// pick a deterministic tagline verb for summaries
export function summaryVerb(ticker: string): string {
  return pick(seeded(ticker, 'verb'), ['주목받고', '거래되고', '평가받고']);
}
