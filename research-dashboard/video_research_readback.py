import json
import math
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

SNAPSHOT_FILE = 'video-research-public-provider-runtime-v3.json'
VIDEO_TIMER = 'research-production-video-discovery.timer'
AI_TIMER = 'research-production-ai-review.timer'
MAX_READ_BYTES = 512 * 1024
TIMER_CORRELATION_MS = 10 * 60 * 1000
SHA40 = re.compile(r'^[0-9a-f]{40}$')
DIGEST64 = re.compile(r'^[0-9a-f]{64}$')
SAFE_CODE = re.compile(r'^[A-Z0-9_.:-]{1,160}$')
FORBIDDEN_KEY = re.compile(r'(?:api.?key|access.?token|refresh.?token|secret|password|private.?key)', re.I)
SAFE_CREDENTIAL_KEYS = frozenset(('credentialConfigured','credentialValueExposed','credentialMutation'))
TRANSCRIPT = frozenset(('AVAILABLE','UNAVAILABLE','NOT_AUTHORIZED','NOT_PROVIDED','UNSUPPORTED','PROVIDER_NOT_CONFIGURED','RATE_LIMITED','QUOTA_EXCEEDED','PARSE_FAILED','UNKNOWN'))
TRUST = frozenset(('TIER_A_OFFICIAL','TIER_B_ACADEMIC','TIER_C_PRIMARY_EXPERT','TIER_D_SECONDARY_EDUCATIONAL','TIER_E_UNVERIFIED_CREATOR','UNKNOWN'))
PROFILES = frozenset(('forward','fast-historical','long-history'))
AI_STATUSES = frozenset(('WAITING_FOR_FREE_AI','PARTIAL_AI_UNAVAILABLE','COMPLETE','NO_NEW_EVIDENCE'))
AI_MODELS = frozenset(('openai/gpt-oss-20b','gemini-3.1-flash-lite'))


def _object(value):
    return value if isinstance(value, dict) else None


def _iso_ms(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    normalized = parsed.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    return int(parsed.timestamp() * 1000) if normalized == value else None


def _canonical_url(video_id):
    from urllib.parse import quote
    return f'https://www.youtube.com/watch?v={quote(video_id, safe="")}'


def _contains_forbidden_key(value):
    if isinstance(value, list):
        return any(_contains_forbidden_key(item) for item in value)
    if not isinstance(value, dict):
        return False
    for key, nested in value.items():
        if key not in SAFE_CREDENTIAL_KEYS and FORBIDDEN_KEY.search(str(key)):
            return True
        if _contains_forbidden_key(nested):
            return True
    return False


def _read_json_optional(path):
    path = Path(path)
    try:
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
        fd = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError as error:
        if getattr(error, 'errno', None) in (2, 40):
            return None
        raise
    try:
        before = os.fstat(fd)
        if not os.path.isfile(path) or before.st_size < 0 or before.st_size > MAX_READ_BYTES:
            raise RuntimeError('VIDEO_RESEARCH_STATE_FILE_UNSAFE')
        chunks = []
        remaining = before.st_size
        while remaining:
            data = os.read(fd, min(65536, remaining))
            if not data:
                break
            chunks.append(data)
            remaining -= len(data)
        after = os.fstat(fd)
        body = b''.join(chunks)
        if len(body) != before.st_size or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns or after.st_ctime_ns != before.st_ctime_ns:
            raise RuntimeError('VIDEO_RESEARCH_STATE_FILE_CHANGED')
        return json.loads(body.decode('utf-8'))
    finally:
        os.close(fd)


def _safe_snapshot(row):
    if not isinstance(row, dict) or _contains_forbidden_key(row):
        return None
    if row.get('runtimeVersion') != 'video-research-public-provider-runtime-v3' or row.get('status') != 'SUCCESS':
        return None
    if row.get('provider') != 'YOUTUBE_DATA_API_V3' or row.get('providerAccess') != 'OFFICIAL_PUBLIC_API' or row.get('requestMode') != 'READ_ONLY_GET':
        return None
    if row.get('credentialConfigured') is not True or row.get('credentialValueExposed') is not False:
        return None
    if not isinstance(row.get('query'), str) or not row['query'].strip():
        return None
    pages = row.get('pagesUsed')
    source_count = row.get('sourceCount')
    if isinstance(pages, bool) or not isinstance(pages, int) or pages < 0 or pages > 1:
        return None
    if isinstance(source_count, bool) or not isinstance(source_count, int) or source_count < 0 or source_count > 5:
        return None
    if not isinstance(row.get('quotaState'), str) or not row['quotaState']:
        return None
    records = row.get('records')
    if not isinstance(records, list) or len(records) != source_count:
        return None
    safety = _object(row.get('safety'))
    required_safety = {
        'researchOnly': True, 'economicEvidenceCredit': 0, 'profitabilityCredit': 0,
        'executionAuthority': 'NONE', 'paidProviderEnabled': False, 'scheduleActive': False,
        'automaticDiscoveryEnabled': False, 'liveTrading': False, 'privateTradingApi': False,
        'realOrderEnabled': False, 'credentialMutation': False, 'transcriptDownloadEnabled': False,
    }
    if not safety or any(safety.get(key) != expected for key, expected in required_safety.items()):
        return None
    provenance = _object(row.get('snapshotProvenance'))
    if not provenance or provenance.get('schemaVersion') != 'video-research-sanitized-snapshot-v1':
        return None
    if not isinstance(provenance.get('sourceHeadSha'), str) or not SHA40.fullmatch(provenance['sourceHeadSha']):
        return None
    if _iso_ms(provenance.get('observedAt')) is None:
        return None
    if provenance.get('publisherMode') != 'LOCAL_ATOMIC_FILE' or provenance.get('providerRuntimeVersion') != 'video-research-public-provider-runtime-v3':
        return None
    if provenance.get('economicEvidenceCredit') != 0 or provenance.get('profitabilityCredit') != 0 or provenance.get('executionAuthority') != 'NONE':
        return None
    for record in records:
        if not isinstance(record, dict):
            return None
        video_id = record.get('videoId')
        if not isinstance(video_id, str) or not video_id or record.get('canonicalUrl') != _canonical_url(video_id):
            return None
        if not isinstance(record.get('title'), str) or not record['title'].strip():
            return None
        for key in ('channelOrPublisher','publishedAt','discoveredAt','language'):
            if record.get(key) is not None and not isinstance(record.get(key), str):
                return None
        duration = record.get('durationSec')
        if duration is not None and (isinstance(duration, bool) or not isinstance(duration, (int,float)) or not math.isfinite(duration) or duration < 0):
            return None
        if record.get('transcriptStatus') not in TRANSCRIPT or record.get('sourceTrustTier') not in TRUST:
            return None
        if record.get('captionsKnownPresent') is not None and not isinstance(record.get('captionsKnownPresent'), bool):
            return None
        if record.get('contentAuthority') != 'UNTRUSTED_EXTERNAL_DATA' or record.get('economicEvidenceCredit') != 0 or record.get('profitabilityCredit') != 0 or record.get('executionAuthority') != 'NONE':
            return None
    return row


def _safe_automation(row):
    if not isinstance(row, dict) or row.get('schemaVersion') != 'research-video-discovery-scan-v1':
        return None
    if row.get('status') not in ('COMPLETE','BLOCKED','WAITING_CONFIGURATION') or _iso_ms(row.get('observedAt')) is None:
        return None
    if not isinstance(row.get('researchSha'), str) or not SHA40.fullmatch(row['researchSha']) or row.get('provider') != 'YOUTUBE_DATA_API_V3':
        return None
    safety = _object(row.get('safety'))
    required = {
        'researchOnly': True, 'metadataDiscoveryOnly': True, 'transcriptDownloadEnabled': False,
        'automaticGeminiExecution': False, 'automaticGroqExecution': False, 'automaticAdoption': False,
        'paidFallback': False, 'economicEvidenceCredit': 0, 'profitabilityCredit': 0,
        'executionAuthority': 'NONE', 'liveTrading': False, 'privateTradingApiAllowed': False, 'realOrderEnabled': False,
    }
    if not safety or any(safety.get(k) != v for k,v in required.items()):
        return None
    if row.get('invocationMode') not in ('MANUAL','SYSTEMD_TIMER') or row.get('scheduledInvocationObserved') is not False:
        return None
    calls = row.get('providerNetworkCalls')
    if isinstance(calls, bool) or not isinstance(calls, int) or calls < 0 or calls > 1:
        return None
    query = row.get('query')
    if query is not None and (not isinstance(query, str) or not query.strip() or len(query) > 120):
        return None
    source_count = row.get('sourceCount')
    if source_count is not None and (isinstance(source_count, bool) or not isinstance(source_count, int) or source_count < 0 or source_count > 5):
        return None
    snapshot_digest = row.get('snapshotDigest')
    if snapshot_digest is not None and (not isinstance(snapshot_digest, str) or not DIGEST64.fullmatch(snapshot_digest)):
        return None
    reason = row.get('reason')
    if reason is not None and (not isinstance(reason, str) or not SAFE_CODE.fullmatch(reason)):
        return None
    step = row.get('nextRequiredStep')
    if not isinstance(step, str) or not SAFE_CODE.fullmatch(step):
        return None
    return {
        'schemaVersion': row['schemaVersion'], 'status': row['status'], 'observedAt': row['observedAt'],
        'researchSha': row['researchSha'], 'query': query, 'sourceCount': source_count,
        'snapshotDigest': snapshot_digest, 'providerNetworkCalls': calls, 'invocationMode': row['invocationMode'],
        'scheduledInvocationObserved': False, 'reason': reason, 'nextRequiredStep': step,
    }


def _safe_ai_review(row):
    if not isinstance(row, dict) or _contains_forbidden_key(row) or row.get('schemaVersion') != 'research-production-ai-scan-v1':
        return None
    if row.get('status') not in AI_STATUSES:
        return None
    observed = row.get('observedAt')
    if isinstance(observed, bool) or not isinstance(observed, int) or observed <= 0:
        return None
    if not isinstance(row.get('researchSha'), str) or not SHA40.fullmatch(row['researchSha']):
        return None
    if row.get('provider') not in (None,'groq','gemini') or row.get('model') not in (None,*AI_MODELS):
        return None
    reason = row.get('reason')
    if not isinstance(reason, str) or not SAFE_CODE.fullmatch(reason):
        return None
    if row.get('invocationMode') not in ('MANUAL','SYSTEMD_TIMER') or row.get('scheduledInvocationObserved') is not False:
        return None
    count_keys = ('providerNetworkCalls','cacheHits')
    if any(isinstance(row.get(k), bool) or not isinstance(row.get(k), int) or row.get(k) < 0 or row.get(k) > 3 for k in count_keys):
        return None
    reviews = row.get('reviews')
    missing = row.get('missingProfiles')
    blocked = row.get('blockedProfiles')
    deferred = row.get('deferredProfiles')
    if not all(isinstance(v, list) and len(v) <= 3 for v in (reviews,missing,blocked,deferred)):
        return None
    proposer = critic = 0
    for review in reviews:
        if not isinstance(review, dict) or review.get('profile') not in PROFILES or review.get('status') != 'READY':
            return None
        if not isinstance(review.get('evidenceDigest'), str) or not DIGEST64.fullmatch(review['evidenceDigest']) or not isinstance(review.get('cacheHit'), bool):
            return None
        if review.get('role') == 'PROPOSER':
            proposer += 1
        elif review.get('role') == 'CRITIC':
            critic += 1
        else:
            return None
    if any(profile not in PROFILES for profile in missing):
        return None
    for items in (blocked,deferred):
        for item in items:
            if not isinstance(item, dict) or item.get('profile') not in PROFILES or not isinstance(item.get('reason'), str) or not SAFE_CODE.fullmatch(item['reason']):
                return None
    safety = _object(row.get('safety'))
    required = {
        'researchProposalOnly': True, 'paidFallback': False, 'executionAuthority': 'NONE',
        'numericPerformanceAuthority': False, 'promotionAuthority': False, 'championAuthority': False,
        'finalHoldoutOpened': False, 'orderAllowed': False, 'liveTrading': False,
        'privateTradingApiAllowed': False, 'evidenceCredit': 0,
    }
    if not safety or any(safety.get(k) != v for k,v in required.items()):
        return None
    if row.get('status') != 'WAITING_FOR_FREE_AI' and (row.get('evidenceCredit') != 0 or row.get('profitabilityProven') is not False or row.get('champion') is not None):
        return None
    return {
        'status': row['status'], 'observedAt': observed, 'researchSha': row['researchSha'],
        'provider': row.get('provider'), 'model': row.get('model'), 'reason': reason,
        'providerNetworkCalls': row['providerNetworkCalls'], 'cacheHits': row['cacheHits'],
        'reviewCount': len(reviews), 'proposerReviewCount': proposer, 'criticReviewCount': critic,
        'missingProfileCount': len(missing), 'blockedProfileCount': len(blocked), 'deferredProfileCount': len(deferred),
        'invocationMode': row['invocationMode'], 'scheduledInvocationObserved': False,
    }


def _parse_systemd_timestamp(value):
    value = value.strip()
    if not value or value.lower() == 'n/a':
        return None
    for fmt in ('%a %Y-%m-%d %H:%M:%S %Z','%a %Y-%m-%d %H:%M:%S.%f %Z'):
        try:
            return int(datetime.strptime(value, fmt).replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            pass
    return None


def probe_systemd_timer(unit):
    try:
        env = dict(os.environ)
        env.update({'LC_ALL':'C','TZ':'UTC','SYSTEMD_COLORS':'0'})
        completed = subprocess.run(
            ['systemctl','show',unit,'--property=UnitFileState','--property=ActiveState','--property=LastTriggerUSec','--no-pager'],
            check=True, capture_output=True, text=True, timeout=0.35, env=env,
        )
        values = {}
        for line in completed.stdout.splitlines():
            key, sep, value = line.partition('=')
            if sep:
                values[key] = value
        return {
            'enabled': values.get('UnitFileState') == 'enabled',
            'active': values.get('ActiveState') == 'active',
            'lastTriggerMs': _parse_systemd_timestamp(values.get('LastTriggerUSec','')),
        }
    except Exception:
        return {'enabled': False, 'active': False, 'lastTriggerMs': None}


def _correlated(proof, observed_ms):
    if not isinstance(proof, dict) or proof.get('enabled') is not True or proof.get('active') is not True:
        return False
    trigger = proof.get('lastTriggerMs')
    if not isinstance(trigger, int) or not isinstance(observed_ms, int):
        return False
    delta = observed_ms - trigger
    return -60_000 <= delta <= TIMER_CORRELATION_MS


def read_video_research_readback(state_root, timer_probe=probe_systemd_timer):
    root = Path(state_root).resolve()
    try:
        snapshot = _read_json_optional(root / 'video-research' / 'current' / SNAPSHOT_FILE)
        automation = _safe_automation(_read_json_optional(root / 'video-research' / 'latest.json'))
        ai_review = _safe_ai_review(_read_json_optional(root / 'ai-review' / 'latest.json'))
    except Exception:
        return {
            'ok': False, 'available': False, 'dataState': 'UNKNOWN', 'reason': 'VIDEO_RESEARCH_STATE_UNAVAILABLE',
            'automation': None, 'aiReview': None, 'economicEvidenceCredit': 0, 'profitabilityCredit': 0, 'executionAuthority': 'NONE',
        }
    if automation:
        proof = timer_probe(VIDEO_TIMER) if automation['invocationMode'] == 'SYSTEMD_TIMER' else None
        automation = dict(automation)
        automation['scheduledInvocationObserved'] = _correlated(proof, _iso_ms(automation['observedAt']))
    if ai_review:
        proof = timer_probe(AI_TIMER) if ai_review['invocationMode'] == 'SYSTEMD_TIMER' else None
        ai_review = dict(ai_review)
        ai_review['scheduledInvocationObserved'] = _correlated(proof, ai_review['observedAt'])
    evidence = _safe_snapshot(snapshot)
    if snapshot is None:
        return {
            'ok': False, 'available': False, 'dataState': 'UNKNOWN', 'reason': 'VIDEO_RESEARCH_SNAPSHOT_MISSING',
            'automation': automation, 'aiReview': ai_review, 'economicEvidenceCredit': 0, 'profitabilityCredit': 0, 'executionAuthority': 'NONE',
        }
    if evidence is None:
        return {
            'ok': False, 'available': False, 'dataState': 'UNKNOWN', 'reason': 'VIDEO_RESEARCH_SNAPSHOT_INVALID',
            'automation': automation, 'aiReview': ai_review, 'economicEvidenceCredit': 0, 'profitabilityCredit': 0, 'executionAuthority': 'NONE',
        }
    return {
        'ok': True, 'available': True, 'dataState': 'MEASURED', **evidence,
        'automation': automation, 'aiReview': ai_review,
        'economicEvidenceCredit': 0, 'profitabilityCredit': 0, 'executionAuthority': 'NONE',
    }
