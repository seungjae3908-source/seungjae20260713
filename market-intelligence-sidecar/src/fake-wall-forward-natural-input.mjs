import {
  buildCandidateObservation,
  canonicalJson,
  sha256,
} from './fake-wall-forward-ledger.mjs';

export const FAKE_WALL_NATURAL_INPUT_CONTRACT = 'market-intelligence-fake-wall-natural-input/v1';

function requiredSha(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function finite(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  const numeric = finite(value);
  if (numeric != null) return numeric;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function upper(value) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.toUpperCase() : null;
}

function naturalIdentity(event, researchCodeSha) {
  const expectedSha = requiredSha(researchCodeSha, 'INVALID_RESEARCH_SHA');
  const serviceSha = requiredSha(
    event?.serviceSha ?? event?.producerSha ?? event?.researchCodeSha,
    'INVALID_FAKE_WALL_SERVICE_SHA',
  );
  if (serviceSha !== expectedSha) throw new Error('FAKE_WALL_NATURAL_IDENTITY_MISMATCH');

  const market = upper(event?.market);
  const symbol = upper(event?.symbol);
  const venue = upper(event?.venue ?? event?.provider);
  const observedAt = timestamp(event?.detectedAt ?? event?.asOf ?? event?.observedAt);
  const referencePrice = finite(event?.referencePrice ?? event?.price);
  if (!market || !symbol || !venue || observedAt == null || !(referencePrice > 0)) {
    throw new Error('FAKE_WALL_NATURAL_EVENT_IDENTITY_INCOMPLETE');
  }
  return { expectedSha, serviceSha, market, symbol, venue, observedAt, referencePrice };
}

function evidenceSnapshotDigest(event, identity) {
  return sha256(canonicalJson({
    contract: FAKE_WALL_NATURAL_INPUT_CONTRACT,
    serviceSha: identity.serviceSha,
    market: identity.market,
    symbol: identity.symbol,
    venue: identity.venue,
    observedAt: identity.observedAt,
    referencePrice: identity.referencePrice,
    candidate: event?.candidate ?? null,
    provenance: event?.provenance ?? null,
    freshness: event?.freshness ?? null,
    qualityFlags: Array.isArray(event?.qualityFlags)
      ? [...new Set(event.qualityFlags.map(String))].sort()
      : [],
  }));
}

export function buildFakeWallNaturalLedgerInput(event = {}, { researchCodeSha } = {}) {
  const identity = naturalIdentity(event, researchCodeSha);
  const snapshotDigest = evidenceSnapshotDigest(event, identity);
  const qualityFlags = Array.isArray(event?.qualityFlags)
    ? [...new Set(event.qualityFlags.map(String))].sort()
    : [];

  let observation = null;
  const candidate = event?.candidate ?? null;
  if (candidate != null) {
    observation = buildCandidateObservation({
      market: identity.market,
      symbol: identity.symbol,
      venue: identity.venue,
      producerSha: identity.serviceSha,
      detectedAt: identity.observedAt,
      referencePrice: identity.referencePrice,
      provenance: {
        ...(event?.provenance ?? {}),
        naturalInputContract: FAKE_WALL_NATURAL_INPUT_CONTRACT,
        serviceSha: identity.serviceSha,
        evidenceSnapshotDigest: snapshotDigest,
      },
      freshness: event?.freshness ?? null,
      qualityFlags,
    }, candidate);

    if (observation) {
      observation = {
        ...observation,
        candidateEventId: observation.candidateId,
        serviceSha: identity.serviceSha,
        evidenceSnapshotDigest: snapshotDigest,
        provenance: {
          ...(observation.provenance ?? {}),
          candidateEventId: observation.candidateId,
          serviceSha: identity.serviceSha,
          evidenceSnapshotDigest: snapshotDigest,
        },
      };
    }
  }

  return {
    contract: FAKE_WALL_NATURAL_INPUT_CONTRACT,
    candidateEventId: observation?.candidateId ?? null,
    serviceSha: identity.serviceSha,
    evidenceSnapshotDigest: snapshotDigest,
    observation,
    mark: {
      market: identity.market,
      symbol: identity.symbol,
      venue: identity.venue,
      observedAt: identity.observedAt,
      referencePrice: identity.referencePrice,
    },
  };
}

export function buildFakeWallNaturalLedgerBatch(events = [], { researchCodeSha } = {}) {
  if (!Array.isArray(events)) throw new Error('FAKE_WALL_NATURAL_EVENTS_INVALID');
  const observations = [];
  const marks = [];
  const lastByIdentity = new Map();

  for (const event of events) {
    const built = buildFakeWallNaturalLedgerInput(event, { researchCodeSha });
    const key = `${built.mark.market}:${built.mark.symbol}:${built.mark.venue}`;
    const previousAt = lastByIdentity.get(key);
    if (previousAt != null && built.mark.observedAt < previousAt) {
      throw new Error('FAKE_WALL_NATURAL_TIME_REVERSAL');
    }
    lastByIdentity.set(key, built.mark.observedAt);
    marks.push(built.mark);
    if (built.observation) observations.push(built.observation);
  }

  return { observations, marks };
}
