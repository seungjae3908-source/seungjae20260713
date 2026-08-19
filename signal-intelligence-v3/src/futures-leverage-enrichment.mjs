import { stopDistancePercent } from './canonical-adapter.mjs';
import { buildBitgetReferenceDepthEvidence } from './bitget-depth-slippage.mjs';
import { buildBitgetIndicativeLeverageEvidence } from './bitget-leverage-evidence.mjs';

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function normalizedDirection(card) {
  const action = String(card?.action ?? '').toUpperCase();
  if (action === 'LONG' || action === 'SHORT') return action;
  const direction = String(card?.direction ?? '').toUpperCase();
  return direction === 'LONG' || direction === 'SHORT' ? direction : null;
}

function cardKey(card) {
  const direction = normalizedDirection(card);
  return direction ? `${String(card?.symbol ?? '').toUpperCase()}|${direction}` : null;
}

function inputKey(input) {
  return `${String(input?.symbol ?? '').toUpperCase()}|${String(input?.direction ?? '').toUpperCase()}`;
}

function horizonBars(strategy) {
  const normalized = String(strategy ?? '').toUpperCase();
  if (normalized === 'SCALPING') return 4;
  if (normalized === 'MID_LONG') return 24;
  return 12;
}

function entryPrice(card) {
  const from = positive(card?.pricePlan?.entryZone?.from);
  const to = positive(card?.pricePlan?.entryZone?.to);
  if (from != null && to != null) return (from + to) / 2;
  return positive(card?.price);
}

function sanitizedReason(error) {
  const text = error instanceof Error ? error.message : String(error ?? 'UNKNOWN');
  return text.replace(/[^A-Z0-9_.:-]/giu, '_').slice(0, 160) || 'UNKNOWN';
}

function createScheduledRetryFetch(baseFetch = fetch, minimumStartIntervalMs = 90) {
  let tail = Promise.resolve();
  let nextStartAt = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const schedule = async (operation) => {
    let release;
    const previous = tail;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const delay = Math.max(0, nextStartAt - Date.now());
    if (delay > 0) await sleep(delay);
    nextStartAt = Date.now() + minimumStartIntervalMs;
    release();
    return operation();
  };
  return async (input, init) => {
    let lastResponse;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await schedule(() => baseFetch(input, init));
        lastResponse = response;
        if (response.status !== 429 && response.status < 500) return response;
        if (attempt < 3) {
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 180 * attempt);
        }
      } catch (error) {
        lastError = error;
        if (init?.signal?.aborted) throw error;
        if (attempt < 3) await sleep(180 * attempt);
      }
    }
    if (lastResponse) return lastResponse;
    throw lastError ?? new Error('BITGET_PUBLIC_FETCH_FAILED');
  };
}

export async function enrichFuturesLeverageInputs(inputs, cards, options = {}) {
  const sourceInputs = Array.isArray(inputs) ? inputs : [];
  const sourceCards = Array.isArray(cards) ? cards : [];
  const maxCandidates = Math.max(0, Math.min(3, Number.isInteger(options.maxCandidates) ? options.maxCandidates : 2));
  if (!maxCandidates || !sourceInputs.length || !sourceCards.length) {
    return Object.freeze({ inputs: sourceInputs, diagnostics: Object.freeze({ evaluated: 0, available: 0, blocked: 0, unavailable: 0 }) });
  }

  const cardMap = new Map();
  for (const card of sourceCards) {
    const key = cardKey(card);
    if (key) cardMap.set(key, card);
  }
  const ranked = sourceInputs
    .filter((input) => input?.market === 'CRYPTO_FUTURES' && ['LONG', 'SHORT'].includes(String(input?.direction ?? '').toUpperCase()))
    .map((input) => ({ input, card: cardMap.get(inputKey(input)) }))
    .filter(({ card }) => card && card?.dataState === 'complete' && card?.dataQuality?.state !== 'DATA_UNTRUSTED')
    .filter(({ card }) => stopDistancePercent(card) != null && finite(card?.spreadPercent) != null)
    .sort((left, right) => Number(right.card?.score ?? 0) - Number(left.card?.score ?? 0)
      || Number(right.card?.confidence ?? 0) - Number(left.card?.confidence ?? 0))
    .slice(0, maxCandidates);

  const selected = new Set(ranked.map(({ input }) => inputKey(input)));
  const evidenceByKey = new Map();
  const failureByKey = new Map();
  const scheduledFetch = createScheduledRetryFetch(options.fetchImpl ?? fetch, options.minimumStartIntervalMs ?? 90);
  let available = 0;
  let blocked = 0;
  let unavailable = 0;

  for (const { input, card } of ranked) {
    const key = inputKey(input);
    try {
      const depth = await buildBitgetReferenceDepthEvidence({ symbol: input.symbol, direction: input.direction }, scheduledFetch);
      const leverageEvidence = await buildBitgetIndicativeLeverageEvidence({
        symbol: input.symbol,
        direction: input.direction,
        entryPrice: entryPrice(card),
        stopDistancePct: stopDistancePercent(card),
        spreadPct: finite(card?.spreadPercent),
        slippagePct: depth.referenceSlippagePct,
        horizonBars: horizonBars(input.strategy ?? options.strategy),
        nowMs: Number.isFinite(options.nowMs) ? options.nowMs : Date.now(),
      }, scheduledFetch);
      evidenceByKey.set(key, Object.freeze({
        ...leverageEvidence,
        evidence: Object.freeze({
          ...leverageEvidence.evidence,
          depth,
          referenceNotionalUsdt: depth.referenceNotionalUsdt,
          referenceSlippagePct: depth.referenceSlippagePct,
        }),
      }));
      available += 1;
    } catch (error) {
      unavailable += 1;
      failureByKey.set(key, sanitizedReason(error));
    }
  }

  const enriched = sourceInputs.map((input) => {
    const key = inputKey(input);
    const evidence = evidenceByKey.get(key);
    const failure = failureByKey.get(key);
    if (evidence) return Object.freeze({
      ...input,
      leverageEvidence: evidence,
      provenance: Object.freeze({ ...(input.provenance ?? {}), leverageEvidence: 'BITGET_PUBLIC_DEPTH_TIER_MMR_MAE' }),
    });
    if (selected.has(key)) return Object.freeze({
      ...input,
      provenance: Object.freeze({ ...(input.provenance ?? {}), leverageEvidence: 'NOT_AVAILABLE', leverageEvidenceReason: failure ?? 'UNKNOWN' }),
    });
    return input;
  });

  for (const input of enriched) {
    if (input?.leverageEvidence?.tiers && !evidenceByKey.has(inputKey(input))) blocked += 1;
  }

  return Object.freeze({
    inputs: Object.freeze(enriched),
    diagnostics: Object.freeze({ evaluated: ranked.length, available, blocked, unavailable }),
  });
}
