// Periodic paper discovery (arXiv q-fin) -> research hypothesis drafts.
//
// Written sources are easier to turn into testable rules than videos: the
// abstract usually names the signal (momentum, mean reversion, volume shock,
// volatility squeeze...). This job fetches recent arXiv papers, de-duplicates
// them and maps each abstract to a DRAFT using only atoms that already exist
// in the audited combination library. A draft is never tested, traded or
// queued until the owner approves it (status PENDING_OWNER_APPROVAL); approved
// drafts are paper-traded through exploratory-paper/user-rules.json.
//
// The keyword mapper is deterministic. An optional `aiDrafter` may refine the
// atom choice, but its answer is accepted only when every atom it returns is
// in the library and on the lane's side; anything else is discarded.
// Public metadata only, no orders, executionAuthority NONE.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { atomsForDirectionV1 } from './combination-atoms-v1.mjs';

export const PAPER_DISCOVERY_CONTRACT_V1 = 'paper-discovery/v1';
export const PAPER_DISCOVERY_POLICY_V1 = Object.freeze({
  intervalMs: 6 * 3_600_000,
  maximumResults: 40,
  maximumStored: 500,
  queries: Object.freeze([
    'cat:q-fin.TR',
    'cat:q-fin.ST AND (abs:momentum OR abs:reversal OR abs:breakout)',
    'cat:q-fin.PM AND abs:cryptocurrency',
  ]),
});

// Keyword -> atoms (ids from the audited library). Long and short variants.
const KEYWORD_ATOMS = Object.freeze([
  { pattern: /time[- ]series momentum|trend[- ]following|moving average/iu, LONG: ['T_CLOSE_ABOVE_SMA200', 'T_SMA20_ABOVE_SMA50'], SHORT: ['T_CLOSE_BELOW_SMA200', 'T_SMA20_BELOW_SMA50'] },
  { pattern: /momentum/iu, LONG: ['M_ROC10_POS', 'M_RSI14_GT_50'], SHORT: ['M_ROC10_NEG', 'M_RSI14_LT_50'] },
  { pattern: /mean[- ]reversion|reversal|overreaction|contrarian/iu, LONG: ['M_RSI2_LT_10', 'V_BB20_BELOW_LOWER'], SHORT: ['M_RSI2_GT_90', 'V_BB20_ABOVE_UPPER'] },
  { pattern: /breakout|channel|donchian|52[- ]week high/iu, LONG: ['P_DONCHIAN20_BREAKOUT', 'P_DONCHIAN55_BREAKOUT'], SHORT: ['P_DONCHIAN20_BREAKDOWN', 'P_DONCHIAN55_BREAKDOWN'] },
  { pattern: /volume|turnover|liquidity shock|order flow/iu, LONG: ['U_RVOL20_GT_2_5', 'U_OBV_ABOVE_SMA20'], SHORT: ['U_RVOL20_GT_2_5', 'U_OBV_BELOW_SMA20'] },
  { pattern: /volatility (?:compression|squeeze|breakout)|low volatility|bollinger/iu, LONG: ['V_BB20_SQUEEZE', 'V_BB20_SQUEEZE_RECENT12'], SHORT: ['V_BB20_SQUEEZE', 'V_BB20_SQUEEZE_RECENT12'] },
  { pattern: /pump|surge|jump|attention/iu, LONG: ['P_SURGE_BREAKOUT_LONG'], SHORT: ['P_POST_SURGE_BREAK_SHORT'] },
  { pattern: /candlestick|engulfing|hammer/iu, LONG: ['C_BULLISH_ENGULFING', 'C_HAMMER'], SHORT: ['C_BEARISH_ENGULFING', 'C_SHOOTING_STAR'] },
]);

const MARKET_HINTS = Object.freeze([
  { pattern: /bitcoin|crypto|cryptocurrenc|ethereum|perpetual/iu, lanes: ['CRYPTO_SPOT_LONG', 'CRYPTO_FUTURES_LONG', 'CRYPTO_FUTURES_SHORT'] },
  { pattern: /korea|kospi|kosdaq/iu, lanes: ['KR_STOCK_LONG'] },
  { pattern: /s&p|nasdaq|u\.s\. (?:stock|equit)|us equit|nyse/iu, lanes: ['US_STOCK_LONG'] },
]);

function decodeXml(text) {
  return String(text ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&amp;/gu, '&').replace(/\s+/gu, ' ').trim();
}

/** Minimal, strict Atom parser for the arXiv API response. */
export function parseArxivAtomV1(xml) {
  const entries = [];
  for (const match of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/gu)) {
    const body = match[1];
    const field = (name) => decodeXml(body.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'u'))?.[1]);
    const id = field('id');
    const arxivId = id.match(/arxiv\.org\/abs\/([^\s<]+)/u)?.[1]?.replace(/v\d+$/u, '');
    if (!arxivId) continue;
    entries.push(Object.freeze({
      arxivId, title: field('title').slice(0, 300), summary: field('summary').slice(0, 2_000),
      published: field('published'), updated: field('updated'),
      url: `https://arxiv.org/abs/${arxivId}`,
      categories: [...body.matchAll(/<category[^>]*term="([^"]+)"/gu)].map((row) => row[1]).slice(0, 8),
    }));
  }
  return entries;
}

/** Deterministic draft: which existing atoms an abstract suggests, per side. */
export function draftHypothesisFromAbstractV1(paper) {
  const text = `${paper.title} ${paper.summary}`;
  const hits = KEYWORD_ATOMS.filter((row) => row.pattern.test(text));
  if (hits.length === 0) return null;
  const lanes = MARKET_HINTS.filter((row) => row.pattern.test(text)).flatMap((row) => row.lanes);
  const targetLanes = lanes.length ? [...new Set(lanes)] : ['CRYPTO_FUTURES_LONG', 'KR_STOCK_LONG', 'US_STOCK_LONG'];
  const drafts = [];
  for (const laneId of targetLanes) {
    const direction = laneId.endsWith('SHORT') ? 'SHORT' : 'LONG';
    const allowed = new Set(atomsForDirectionV1(direction).map((atom) => atom.id));
    const atoms = [...new Set(hits.flatMap((row) => row[direction]))].filter((id) => allowed.has(id)).slice(0, 3);
    if (atoms.length > 0) drafts.push(Object.freeze({ laneId, direction, atoms: Object.freeze(atoms) }));
  }
  if (drafts.length === 0) return null;
  return Object.freeze({ method: 'KEYWORD_MAPPING_V1', themes: hits.map((row) => String(row.pattern.source).split('|')[0].replace(/\\|\(|\)|\?:/gu, '')), drafts: Object.freeze(drafts) });
}

/** Accepts an AI refinement only if it uses library atoms on the right side. */
export function validateAiDraftV1(answer, laneId) {
  const direction = String(laneId).endsWith('SHORT') ? 'SHORT' : 'LONG';
  const allowed = new Set(atomsForDirectionV1(direction).map((atom) => atom.id));
  const atoms = Array.isArray(answer?.atoms) ? answer.atoms.map(String) : [];
  if (atoms.length < 1 || atoms.length > 3 || atoms.some((id) => !allowed.has(id))) return null;
  return Object.freeze({ laneId, direction, atoms: Object.freeze([...new Set(atoms)]) });
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export async function runPaperDiscoveryV1({
  stateRoot,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  policy = PAPER_DISCOVERY_POLICY_V1,
  aiDrafter = null,
} = {}) {
  if (!stateRoot) throw new Error('PAPER_DISCOVERY_STATE_ROOT_REQUIRED');
  const observedAt = now();
  const nowMs = Date.parse(observedAt);
  const path = join(stateRoot, 'paper-discovery', 'state.json');
  const state = (await readJson(path)) ?? { contract: PAPER_DISCOVERY_CONTRACT_V1, lastRunAt: null, papers: {} };
  if (state.lastRunAt && nowMs - Date.parse(state.lastRunAt) < policy.intervalMs) {
    return Object.freeze({ status: 'NOT_DUE', nextRunAt: new Date(Date.parse(state.lastRunAt) + policy.intervalMs).toISOString(), stored: Object.keys(state.papers).length });
  }
  // After a failed run (network/provider), retry hourly rather than every tick.
  if (state.lastFailedAt && nowMs - Date.parse(state.lastFailedAt) < 3_600_000) {
    return Object.freeze({ status: 'RETRY_LATER', stored: Object.keys(state.papers).length });
  }
  const log = [];
  let added = 0;
  let succeeded = 0;
  for (const query of policy.queries) {
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&max_results=${policy.maximumResults}`;
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/atom+xml', 'user-agent': 'seungjae-research/1.0 (paper discovery)' } });
      if (!response.ok) throw new Error(`ARXIV_HTTP_${response.status}`);
      succeeded += 1;
      for (const paper of parseArxivAtomV1(await response.text())) {
        if (state.papers[paper.arxivId]) continue;
        let draft = draftHypothesisFromAbstractV1(paper);
        if (draft && typeof aiDrafter === 'function') {
          try {
            const refined = (await aiDrafter(paper, draft))?.drafts ?? [];
            const valid = refined.map((row) => validateAiDraftV1(row, row?.laneId)).filter(Boolean);
            if (valid.length) draft = Object.freeze({ ...draft, method: 'KEYWORD_MAPPING_V1+AI_REFINED', drafts: Object.freeze(valid) });
          } catch (error) { log.push(`AI_DRAFT_FAILED:${String(error?.message ?? error).slice(0, 80)}`); }
        }
        state.papers[paper.arxivId] = {
          ...paper,
          discoveredAt: observedAt,
          draft,
          status: draft ? 'PENDING_OWNER_APPROVAL' : 'NO_TESTABLE_SIGNAL',
          draftId: draft ? createHash('sha256').update(JSON.stringify([paper.arxivId, draft.drafts])).digest('hex').slice(0, 16) : null,
        };
        added += 1;
      }
    } catch (error) {
      log.push(`${query}:${String(error?.message ?? error).slice(0, 100)}`);
    }
  }
  const sorted = Object.values(state.papers).sort((a, b) => String(b.discoveredAt).localeCompare(String(a.discoveredAt)) || a.arxivId.localeCompare(b.arxivId));
  state.papers = Object.fromEntries(sorted.slice(0, policy.maximumStored).map((row) => [row.arxivId, row]));
  if (succeeded > 0) { state.lastRunAt = observedAt; state.lastFailedAt = null; }
  else state.lastFailedAt = observedAt;
  await atomicJson(path, state);
  const pending = sorted.filter((row) => row.status === 'PENDING_OWNER_APPROVAL');
  const summary = Object.freeze({
    contract: PAPER_DISCOVERY_CONTRACT_V1, status: succeeded > 0 ? 'RAN' : 'FAILED_RETRY_HOURLY', observedAt, added, stored: Object.keys(state.papers).length,
    pendingApproval: pending.length,
    latestPending: pending.slice(0, 20).map((row) => ({ arxivId: row.arxivId, title: row.title, url: row.url, draftId: row.draftId, drafts: row.draft.drafts })),
    log, executionAuthority: 'NONE', automaticApproval: false,
  });
  await atomicJson(join(stateRoot, 'latest', 'paper-discovery-v1.json'), summary);
  return summary;
}
