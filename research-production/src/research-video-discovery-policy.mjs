// Pure configuration shared by consent planning and the public discovery worker.
// Missing optional rotation uses the existing eight research topics; an explicit
// malformed/empty/unsafe rotation is never repaired or replaced with defaults.
const DEFAULT_QUERIES = Object.freeze([
  '국내 주식 단타 거래량 돌파 전략',
  '미국 주식 데이트레이딩 RVOL ORB 전략',
  '코인 현물 CVD 오더플로우 VWAP 전략',
  '코인 선물 OI CVD 테이커 플로우 전략',
  'korea stock momentum volume breakout strategy',
  'US stocks in play RVOL ORB retest strategy',
  'crypto spot order flow CVD VWAP reclaim strategy',
  'crypto futures open interest CVD trend strategy',
]);
const secretPattern = /(?:bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+)/iu;
const controlPattern = /[\u0000-\u001f\u007f]/u;

export function resolveResearchVideoDiscoveryQueries(env = {}) {
  const raw = String(env.RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON ?? '').trim();
  if (!raw) return [...DEFAULT_QUERIES];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('VIDEO_DISCOVERY_QUERIES_INVALID'); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) {
    throw new Error('VIDEO_DISCOVERY_QUERIES_INVALID');
  }
  const queries = parsed.map(value => typeof value === 'string' ? value.normalize('NFKC').trim() : null);
  if (queries.some(query => !query || query.length > 120 || controlPattern.test(query) || secretPattern.test(query))
    || new Set(queries).size !== queries.length) throw new Error('VIDEO_DISCOVERY_QUERIES_INVALID');
  return queries;
}
