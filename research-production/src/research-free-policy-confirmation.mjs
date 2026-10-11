import { parseEnv } from 'node:util';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';

export const CONFIRMATION_PATH = '/etc/investment-research/research-free-confirmation.json';
const AI_KEYS = ['RESEARCH_AI_FREE_TIER_CONFIRMED', 'AI_CHAT_PROVIDER', 'RESEARCH_AI_MAX_CALLS_PER_SCAN'];
const VIDEO_KEYS = ['RESEARCH_VIDEO_DISCOVERY_APPROVED', 'RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS', 'RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON', 'RESEARCH_VIDEO_DISCOVERY_REGION_CODE', 'RESEARCH_VIDEO_DISCOVERY_RELEVANCE_LANGUAGE', 'RESEARCH_VIDEO_DISCOVERY_PUBLISHED_AFTER_HOURS'];

function boundedInteger(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('RESEARCH_CONFIRMATION_BOUNDS_INVALID');
  return n;
}

/** Owner confirmation changes consent only, never numeric investment policy or evidence. */
export function buildConfirmedResearchPolicies({ aiText, videoText, targetSha, ownerCommentId, observedAt }) {
  if (!/^[a-f0-9]{40}$/.test(targetSha) || !/^[1-9]\d{0,19}$/.test(String(ownerCommentId)) || !Number.isSafeInteger(observedAt) || observedAt <= 0) throw new Error('RESEARCH_OWNER_CONFIRMATION_REQUIRED');
  const ai = parseEnv(aiText), video = parseEnv(videoText);
  const provider = String(ai.AI_CHAT_PROVIDER ?? 'groq').trim().toLowerCase();
  if (!['gemini', 'groq'].includes(provider)) throw new Error('RESEARCH_CONFIRMATION_PROVIDER_INVALID');
  // Models are held by the separate, normalized provider environment, not consent.
  for (const key of Object.keys(ai)) if (!AI_KEYS.includes(key) && !['GROQ_MODEL', 'GEMINI_MODEL'].includes(key)) throw new Error('RESEARCH_CONFIRMATION_UNSUPPORTED_AI_KEY');
  if (ai.GROQ_MODEL && ai.GROQ_MODEL !== 'openai/gpt-oss-20b') throw new Error('RESEARCH_CONFIRMATION_PAID_MODEL_FORBIDDEN');
  if (ai.GEMINI_MODEL && ai.GEMINI_MODEL !== 'gemini-3.1-flash-lite') throw new Error('RESEARCH_CONFIRMATION_PAID_MODEL_FORBIDDEN');
  for (const key of Object.keys(video)) if (!VIDEO_KEYS.includes(key)) throw new Error('RESEARCH_CONFIRMATION_UNSUPPORTED_VIDEO_KEY');
  const queries = JSON.parse(video.RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON ?? '[]');
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 8 || new Set(queries).size !== queries.length || queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 120 || /[\r\n]/.test(q))) throw new Error('RESEARCH_CONFIRMATION_VIDEO_QUERIES_INVALID');
  const region = String(video.RESEARCH_VIDEO_DISCOVERY_REGION_CODE ?? '').trim();
  const language = String(video.RESEARCH_VIDEO_DISCOVERY_RELEVANCE_LANGUAGE ?? '').trim();
  if (region && !/^[A-Z]{2}$/.test(region)) throw new Error('RESEARCH_CONFIRMATION_REGION_INVALID');
  if (language && !/^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/.test(language)) throw new Error('RESEARCH_CONFIRMATION_LANGUAGE_INVALID');
  const aiPolicy = { RESEARCH_AI_FREE_TIER_CONFIRMED: 'true', AI_CHAT_PROVIDER: provider, RESEARCH_AI_MAX_CALLS_PER_SCAN: String(boundedInteger(ai.RESEARCH_AI_MAX_CALLS_PER_SCAN, 3, 1, 3)) };
  const videoPolicy = {
    RESEARCH_VIDEO_DISCOVERY_APPROVED: 'true',
    RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS: String(boundedInteger(video.RESEARCH_VIDEO_DISCOVERY_MAX_RESULTS, 3, 1, 3)),
    RESEARCH_VIDEO_DISCOVERY_QUERIES_JSON: JSON.stringify(queries),
    RESEARCH_VIDEO_DISCOVERY_REGION_CODE: region,
    RESEARCH_VIDEO_DISCOVERY_RELEVANCE_LANGUAGE: language,
    RESEARCH_VIDEO_DISCOVERY_PUBLISHED_AFTER_HOURS: String(boundedInteger(video.RESEARCH_VIDEO_DISCOVERY_PUBLISHED_AFTER_HOURS, 720, 1, 2160)),
  };
  const encode = value => Object.entries(value).map(([key, text]) => `${key}=${text}`).join('\n') + '\n';
  return Object.freeze({
    aiText: encode(aiPolicy), videoText: encode(videoPolicy),
    confirmation: {
      schemaVersion: 'research-free-owner-confirmation-v1', targetSha, ownerCommentId: String(ownerCommentId), observedAt,
      providers: ['gemini', 'groq'], freeOnlyConfirmed: true, publicVideoDiscoveryApproved: true,
      paidFallback: false, executionAuthority: 'NONE', liveTrading: false, privateApi: false, orderAllowed: false,
    },
  });
}

export function validResearchFreeConfirmation(value, targetSha) {
  return Boolean(value?.schemaVersion === 'research-free-owner-confirmation-v1'
    && /^[a-f0-9]{40}$/.test(targetSha) && value.targetSha === targetSha
    && /^[1-9]\d{0,19}$/.test(String(value.ownerCommentId))
    && Number.isSafeInteger(value.observedAt) && value.observedAt > 0 && value.observedAt <= Date.now()
    && JSON.stringify(value.providers) === JSON.stringify(['gemini', 'groq'])
    && value.freeOnlyConfirmed === true && value.paidFallback === false
    && value.executionAuthority === 'NONE' && value.liveTrading === false && value.privateApi === false && value.orderAllowed === false);
}

/** Fixed root-owned non-secret consent file. Browser input is never an authority source. */
export function readResearchFreeConfirmation(targetSha) {
  if (process.platform !== 'linux') return false;
  let fd;
  try {
    const directory = lstatSync('/etc/investment-research');
    if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022) !== 0) return false;
    fd = openSync(CONFIRMATION_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || metadata.size > 4096) return false;
    return validResearchFreeConfirmation(JSON.parse(readFileSync(fd, 'utf8')), targetSha);
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
