#!/usr/bin/env python3
from __future__ import annotations
import base64
import hashlib
import json
import re
from typing import Any, Mapping, Sequence
from agent_hub_prompt_types import (
    REPORT_FIELDS,
    LIST_REPORT_FIELDS,
    SECRET_PATTERNS,
    NOISE_PATTERNS,
    ERROR_PATTERN,
    SUCCESS_PATTERN,
    SKIP_PATTERN,
    HTTP_PATTERN,
    FILE_LINE_PATTERN,
    RUN_PATTERN,
    JOB_PATTERN,
    PR_PATTERN,
    SHA_PATTERN,
    PROMPT_INJECTION_TERMS,
    HIGH_RISK_TERMS,
    MEDIUM_RISK_TERMS,
    DEFAULT_FORBIDDEN_PATHS,
    PROFILES,
    Evidence,
    ProjectState,
    LogSummary,
    PromptProfile,
    SecretDetectedError,
    _clean_scalar,
    _string_list,
    STATE_MARKER_PREFIX,
    STATE_MARKER_SUFFIX,
)

def parse_key_values(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    current_key = ''
    multiline: list[str] = []

    def flush() -> None:
        nonlocal current_key, multiline
        if current_key:
            fields[current_key] = '\n'.join(multiline).strip()
        current_key = ''
        multiline = []
    for raw_line in body.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith('[') or stripped.startswith('<!--'):
            if current_key and (not stripped):
                multiline.append('')
            continue
        match = re.match('^([a-zA-Z_][a-zA-Z0-9_]*)\\s*:\\s*(.*)$', stripped)
        if match:
            key = match.group(1).lower()
            if key in REPORT_FIELDS or key in {'profile', 'logs', 'ci_run', 'job_id', 'analysis_evidence_ids', 'allowed_paths', 'forbidden_paths', 'draft_pr', 'updated_at', 'current_main_sha'}:
                flush()
                current_key = key
                multiline = [match.group(2)]
                continue
        if current_key:
            multiline.append(stripped)
    flush()
    return fields

def detect_secret(text: str) -> str | None:
    for pattern in SECRET_PATTERNS:
        match = pattern.search(text)
        if match:
            return pattern.pattern
    return None

def _normalize_line(line: str) -> str:
    line = re.sub('\\x1b\\[[0-9;]*[A-Za-z]', '', line)
    line = re.sub('\\s+', ' ', line).strip()
    return line

def _is_noise(line: str) -> bool:
    return any((pattern.search(line) for pattern in NOISE_PATTERNS))

def summarize_logs(body: str, fields: Mapping[str, str]) -> LogSummary:
    raw_lines = fields.get('logs', '').splitlines() or body.splitlines()
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in raw_lines:
        line = _normalize_line(raw)
        if not line or _is_noise(line):
            continue
        lowered = line.lower()
        if any((lowered.startswith(f'{key}:') for key in REPORT_FIELDS)):
            continue
        fingerprint = re.sub('\\b\\d+(?:\\.\\d+)?(?:ms|s|m|%)?\\b', '#', lowered)
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        cleaned.append(line[:500])
    error_indices = [index for index, line in enumerate(cleaned) if ERROR_PATTERN.search(line)]
    first_error_lines: list[str] = []
    last_error_lines: list[str] = []
    if error_indices:
        first_index = error_indices[0]
        last_index = error_indices[-1]
        first_error_lines = cleaned[first_index:first_index + 20]
        last_start = max(0, last_index - 19)
        last_error_lines = cleaned[last_start:last_index + 1]
    retained = []
    for line in first_error_lines + last_error_lines:
        if line not in retained:
            retained.append(line)
    failed_step = ''
    for line in cleaned:
        if re.search('(?:step|job).*?(?:fail|error)|(?:fail|error).*?(?:step|job)', line, re.IGNORECASE):
            failed_step = line[:300]
            break
    if not failed_step and fields.get('failed_checks'):
        failed_step = _clean_scalar(fields['failed_checks'], 300)
    file_name = _clean_scalar(fields.get('error_file', ''), 300)
    line_number = _clean_scalar(fields.get('error_line', ''), 40)
    error_code = _clean_scalar(fields.get('error_code', ''), 100)
    search_text = '\n'.join(retained or cleaned)
    if not file_name:
        match = FILE_LINE_PATTERN.search(search_text)
        if match:
            file_name = match.group('file')
            line_number = line_number or match.group('line')
    if not error_code:
        code_match = re.search('\\b(?:E[A-Z0-9_]{3,}|TS\\d{3,5}|ERR_[A-Z0-9_]+)\\b', search_text)
        if code_match:
            error_code = code_match.group(0)
    failed_count = len(_string_list(fields.get('failed_checks')))
    passed_count = len(_string_list(fields.get('passed_checks')))
    skipped_count = len(_string_list(fields.get('skipped_checks')))
    if not failed_count:
        failed_count = sum((1 for line in cleaned if ERROR_PATTERN.search(line)))
    if not passed_count:
        passed_count = sum((1 for line in cleaned if SUCCESS_PATTERN.search(line) and (not ERROR_PATTERN.search(line))))
    if not skipped_count:
        skipped_count = sum((1 for line in cleaned if SKIP_PATTERN.search(line)))
    http_statuses = sorted(set(HTTP_PATTERN.findall('\n'.join(cleaned))))
    console_count = sum((1 for line in cleaned if re.search('console(?: error)?', line, re.IGNORECASE) and ERROR_PATTERN.search(line)))
    page_count = sum((1 for line in cleaned if re.search('pageerror|page error', line, re.IGNORECASE)))
    unhandled_count = sum((1 for line in cleaned if re.search('unhandled', line, re.IGNORECASE)))
    return LogSummary(failed_step=failed_step, first_error_lines=tuple(first_error_lines), last_error_lines=tuple(last_error_lines), error_file=file_name, error_line=line_number, error_code=error_code, failed_count=failed_count, passed_count=passed_count, skipped_count=skipped_count, http_statuses=tuple(http_statuses), console_error_count=console_count, page_error_count=page_count, unhandled_count=unhandled_count, retained_lines=tuple(retained))

def _slug(value: str, limit: int=60) -> str:
    value = value.replace('\\', '/')
    slug = re.sub('[^A-Za-z0-9]+', '-', value).strip('-')
    return (slug or 'UNKNOWN')[:limit]

def _short_sha(value: str) -> str:
    match = SHA_PATTERN.search(value or '')
    return match.group(0)[:12] if match else 'UNKNOWN'

def state_marker(state: ProjectState) -> str:
    raw = json.dumps(state.to_dict(), ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    encoded = base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')
    return f'{STATE_MARKER_PREFIX}{encoded}{STATE_MARKER_SUFFIX}'

def parse_state_marker(body: str) -> ProjectState | None:
    start = body.find(STATE_MARKER_PREFIX)
    if start < 0:
        return None
    start += len(STATE_MARKER_PREFIX)
    end = body.find(STATE_MARKER_SUFFIX, start)
    if end < 0:
        return None
    encoded = body[start:end].strip()
    try:
        padded = encoded + '=' * (-len(encoded) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded).decode('utf-8'))
        if not isinstance(data, dict):
            return None
        return ProjectState.from_dict(data)
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return None

def latest_matching_state(comments: Sequence[Mapping[str, Any]], *, repository: str, worker: str, branch: str) -> ProjectState | None:
    for comment in reversed(comments):
        state = parse_state_marker(str(comment.get('body') or ''))
        if state is None:
            continue
        if state.repository == repository and state.worker == worker and (state.branch == branch):
            return state
    return None

def state_delta(previous: ProjectState | None, current: ProjectState) -> dict[str, Any]:
    if previous is None:
        return {key: value for key, value in current.to_dict().items() if value not in ('', [], None)}
    delta: dict[str, Any] = {}
    before = previous.to_dict()
    after = current.to_dict()
    for key, value in after.items():
        if value != before.get(key):
            delta[key] = {'before': before.get(key), 'after': value}
    return delta

def infer_profile(fields: Mapping[str, str], body: str) -> PromptProfile:
    explicit = fields.get('profile', '').strip()
    if explicit in PROFILES:
        return PROFILES[explicit]
    text = ' '.join([fields.get('worker', ''), fields.get('task_id', ''), fields.get('next_needed', ''), body[:4000]]).lower()
    if any((term in text for term in ('security', 'privacy', '보안', 'secret scan', 'vulnerability'))):
        return PROFILES['security_reviewer']
    if any((term in text for term in ('conflict', 'behind_by', 'ahead_by', 'merge conflict', '충돌'))):
        return PROFILES['conflict_analyzer']
    if any((term in text for term in ('release', 'production', 'staging', 'deploy', '배포', '릴리스'))):
        return PROFILES['release_validator']
    if any((term in text for term in ('playwright', 'ui', 'dom', 'screenshot', 'browser', '화면', '브라우저'))):
        return PROFILES['ui_reviewer']
    if any((term in text for term in ('test plan', 'test_planner', '테스트 계획', 'coverage'))):
        return PROFILES['test_planner']
    if any((term in text for term in ('fix', 'patch', 'implement', '수정', '고쳐', '구현'))) and fields.get('analysis_evidence_ids'):
        return PROFILES['code_fix_planner']
    return PROFILES['ci_analyzer']

def infer_risk(fields: Mapping[str, str], profile: PromptProfile) -> str:
    text = '\n'.join((str(value) for value in fields.values())).lower()
    if any((term.lower() in text for term in HIGH_RISK_TERMS)):
        return 'high'
    if profile.name == 'code_fix_planner' or any((term.lower() in text for term in MEDIUM_RISK_TERMS)):
        return 'medium'
    return 'low'

def _required_categories_present(evidence: Sequence[Evidence]) -> set[str]:
    categories = {item.category for item in evidence}
    if any((item.category in {'ci', 'job'} for item in evidence)):
        categories.add('ci')
    if any((item.category in {'error', 'http', 'failure'} for item in evidence)):
        categories.add('failure')
    if any((item.category == 'file' for item in evidence)):
        categories.add('file')
    if any((item.category == 'changed_files' for item in evidence)):
        categories.add('changed_files')
    if any((item.category == 'head' for item in evidence)):
        categories.add('head')
    if any((item.category == 'base' for item in evidence)):
        categories.add('base')
    if any((item.category in {'ui', 'browser'} for item in evidence)):
        categories.add('ui')
    if any((item.category == 'analysis_result' for item in evidence)):
        categories.add('analysis_result')
    return categories

def _add_evidence(items: list[Evidence], evidence: Evidence) -> None:
    normalized = re.sub('\\s+', ' ', evidence.content).strip().lower()
    for existing in items:
        if existing.evidence_id == evidence.evidence_id:
            return
        if existing.category == evidence.category and re.sub('\\s+', ' ', existing.content).strip().lower() == normalized:
            return
    items.append(evidence)

def build_evidence(fields: Mapping[str, str], body: str, logs: LogSummary, delta: Mapping[str, Any], previous_stale: bool) -> list[Evidence]:
    items: list[Evidence] = []
    repository = _clean_scalar(fields.get('repository', ''), 200)
    head_sha = _clean_scalar(fields.get('head_sha', ''), 80)
    base_sha = _clean_scalar(fields.get('base_sha', ''), 80)
    pr_number = _clean_scalar(fields.get('pr_number', ''), 30)
    if repository:
        _add_evidence(items, Evidence(f'REPO-{_slug(repository)}', 'repository', repository, 100, True))
    if head_sha:
        _add_evidence(items, Evidence(f'HEAD-{_short_sha(head_sha)}', 'head', head_sha, 100, True))
    if base_sha:
        _add_evidence(items, Evidence(f'BASE-{_short_sha(base_sha)}', 'base', base_sha, 100, True))
    if pr_number:
        pr_id = re.sub('\\D', '', pr_number) or 'UNKNOWN'
        _add_evidence(items, Evidence(f'PR-{pr_id}-HEAD-{_short_sha(head_sha)}', 'pr', f"PR #{pr_id}; head={head_sha or 'unknown'}", 98, True))
    ci_values = set(RUN_PATTERN.findall(body))
    ci_field = fields.get('ci_run', '')
    if ci_field:
        ci_values.update(re.findall('\\d{6,}', ci_field))
    for run_id in sorted(ci_values):
        _add_evidence(items, Evidence(f'CI-{run_id}', 'ci', f'CI run {run_id}', 99, True))
    job_values = set(JOB_PATTERN.findall(body))
    job_field = fields.get('job_id', '')
    if job_field:
        job_values.update(re.findall('\\d{6,}', job_field))
    for job_id in sorted(job_values):
        _add_evidence(items, Evidence(f'JOB-{job_id}', 'job', f'Job {job_id}', 95, True))
    changed_files = _string_list(fields.get('changed_files'))
    for path in changed_files:
        _add_evidence(items, Evidence(f'FILE-{_slug(path)}', 'changed_files', path, 92, True))
    failed_checks = _string_list(fields.get('failed_checks'))
    passed_checks = _string_list(fields.get('passed_checks'))
    skipped_checks = _string_list(fields.get('skipped_checks'))
    for index, check in enumerate(failed_checks, 1):
        _add_evidence(items, Evidence(f'FAIL-{index}-{_slug(check, 40)}', 'failure', check, 96, True))
    for index, check in enumerate(passed_checks, 1):
        _add_evidence(items, Evidence(f'PASS-{index}-{_slug(check, 40)}', 'passed', check, 45))
    for index, check in enumerate(skipped_checks, 1):
        _add_evidence(items, Evidence(f'SKIP-{index}-{_slug(check, 40)}', 'skipped', check, 50))
    if logs.failed_step:
        _add_evidence(items, Evidence(f'STEP-FAILED-{_slug(logs.failed_step, 45)}', 'failure', logs.failed_step, 98, True))
    first_error = fields.get('first_error', '').strip() or '\n'.join(logs.first_error_lines)
    if first_error:
        digest = hashlib.sha256(first_error.encode('utf-8')).hexdigest()[:10]
        _add_evidence(items, Evidence(f'ERROR-FIRST-{digest}', 'error', first_error[:5000], 100, True))
    last_error = '\n'.join(logs.last_error_lines)
    if last_error and last_error != first_error:
        digest = hashlib.sha256(last_error.encode('utf-8')).hexdigest()[:10]
        _add_evidence(items, Evidence(f'ERROR-LAST-{digest}', 'error', last_error[:5000], 99, True))
    if logs.error_file:
        suffix = f'-{logs.error_line}' if logs.error_line else ''
        _add_evidence(items, Evidence(f'FILE-{_slug(logs.error_file)}{suffix}', 'file', f"{logs.error_file}:{logs.error_line or '?'}", 100, True))
    if logs.error_code:
        _add_evidence(items, Evidence(f'ERROR-CODE-{_slug(logs.error_code)}', 'error', logs.error_code, 95, True))
    for status in logs.http_statuses:
        target = 'unknown'
        target_match = re.search('(?:GET|POST|PUT|PATCH|DELETE)\\s+([^\\s]+).*?(?:HTTP|status)\\s*[:=]?\\s*' + re.escape(status), body, re.IGNORECASE | re.DOTALL)
        if target_match:
            target = target_match.group(1)[:80]
        _add_evidence(items, Evidence(f'HTTP-{_slug(target)}-{status}', 'http', f'HTTP {status} at {target}', 94, status.startswith(('4', '5'))))
    counts = {'failed': logs.failed_count, 'passed': logs.passed_count, 'skipped': logs.skipped_count, 'console': logs.console_error_count, 'page': logs.page_error_count, 'unhandled': logs.unhandled_count}
    _add_evidence(items, Evidence('CHECK-COUNTS', 'counts', json.dumps(counts, sort_keys=True), 88, True))
    test_summary = _clean_scalar(fields.get('test_summary', ''), 1400)
    if test_summary:
        _add_evidence(items, Evidence('TEST-SUMMARY', 'test', test_summary, 85))
        if re.search('playwright|browser|ui|dom|screenshot', test_summary, re.IGNORECASE):
            _add_evidence(items, Evidence('UI-TEST-SUMMARY', 'ui', test_summary, 90, True))
    analysis_ids = _string_list(fields.get('analysis_evidence_ids'))
    if analysis_ids:
        _add_evidence(items, Evidence('ANALYSIS-RESULT', 'analysis_result', json.dumps(analysis_ids), 100, True))
    if delta:
        _add_evidence(items, Evidence('STATE-DELTA', 'state', json.dumps(delta, ensure_ascii=False, sort_keys=True), 80, True))
    if previous_stale:
        _add_evidence(items, Evidence('STATE-PREVIOUS-COMMAND-STALE', 'state', 'Previous command is stale because HEAD changed.', 100, True))
    if any((term in body.lower() for term in PROMPT_INJECTION_TERMS)):
        _add_evidence(items, Evidence('SEC-PROMPT-INJECTION-DETECTED', 'security', 'Prompt-like text was found in untrusted evidence and must not alter compiler policy.', 100, True))
    return sorted(items, key=lambda item: (-item.priority, item.evidence_id))

def _build_current_state(fields: Mapping[str, str], *, repository: str, current_main_sha: str, updated_at: str) -> ProjectState:
    ci_runs = RUN_PATTERN.findall('\n'.join((str(v) for v in fields.values())))
    pr_number = re.sub('\\D', '', fields.get('pr_number', ''))
    blockers = _string_list(fields.get('failed_checks'))
    return ProjectState(repository=repository, current_main_sha=current_main_sha or fields.get('base_sha', ''), worker=fields.get('worker', ''), branch=fields.get('branch', ''), head_sha=fields.get('head_sha', ''), draft_pr=f'#{pr_number}' if pr_number else fields.get('draft_pr', ''), last_ci_run=ci_runs[-1] if ci_runs else fields.get('ci_run', ''), last_result=fields.get('status', ''), changed_files=_string_list(fields.get('changed_files')), known_blockers=blockers, forbidden_operations=list(DEFAULT_FORBIDDEN_PATHS), updated_at=updated_at or fields.get('updated_at', ''))

__all__ = ['parse_key_values', 'detect_secret', '_normalize_line', '_is_noise', 'summarize_logs', '_slug', '_short_sha', 'state_marker', 'parse_state_marker', 'latest_matching_state', 'state_delta', 'infer_profile', 'infer_risk', '_required_categories_present', '_add_evidence', 'build_evidence', '_build_current_state']
