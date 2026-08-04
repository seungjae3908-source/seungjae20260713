#!/usr/bin/env python3
from __future__ import annotations
import json
import re
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

POLICY_VERSION = 'prompt-compiler-v1'

PROVIDER = 'gemini-developer-api-free'

REPORT_MARKER = '[WORKER_REPORT]'

STATE_MARKER_PREFIX = '<!-- agent-hub-state:'

STATE_MARKER_SUFFIX = ' -->'

STATUS_VALUES = {'needs_context', 'ready', 'waiting_approval', 'blocked', 'no_action'}

RISK_VALUES = {'low', 'medium', 'high'}

MODEL_OUTPUT_FIELDS = ('status', 'action_type', 'target_worker', 'risk_level', 'summary', 'evidence_ids', 'assumptions', 'missing_context', 'reason', 'exact_files_or_logs_needed', 'safe_read_only_command', 'repository', 'branch', 'base_sha', 'expected_head_sha', 'allowed_paths', 'forbidden_paths', 'instruction', 'validation', 'stop_conditions', 'requires_user_approval', 'confidence', 'provider', 'model', 'policy_version')

REPORT_FIELDS = ('task_id', 'worker', 'repository', 'branch', 'head_sha', 'base_sha', 'pr_number', 'status', 'changed_files', 'failed_checks', 'passed_checks', 'skipped_checks', 'first_error', 'error_file', 'error_line', 'error_code', 'test_summary', 'next_needed', 'approval_required')

LIST_REPORT_FIELDS = {'changed_files', 'failed_checks', 'passed_checks', 'skipped_checks'}

DEFAULT_FORBIDDEN_PATHS = ('.github/workflows/**', '.env*', '**/*secret*', '**/*credential*', '**/*private-key*', 'ops/**', 'infra/**', 'deploy/**', 'supabase/**', '**/migrations/**', 'scripts/agent_hub_policy.py', 'scripts/agent_hub_prompt_compiler.py', 'docs/agent-hub-policy/**', '**/dist/**', '**/coverage/**', '**/node_modules/**')

HIGH_RISK_TERMS = ('merge', '병합', 'rebase', 'force-push', 'force push', 'workflow_dispatch', 'production', '운영배포', '운영 배포', 'staging deploy', 'server restart', '서버 재시작', 'delete', '삭제', 'secret', 'credential', 'permission', '권한', 'rls', 'migration', 'database', 'supabase', 'live order', 'real order', '실주문', '자동매수', '자동매도', 'paid', '유료 전환')

MEDIUM_RISK_TERMS = ('modify', 'change', 'fix', 'implement', 'create', 'update', 'patch', '수정', '변경', '구현', '추가', '생성', '고쳐', '보완', 'commit', 'push')

PROMPT_INJECTION_TERMS = ('ignore previous', 'ignore all previous', 'system prompt', 'developer message', 'reveal your instructions', 'do not follow', '이전 지시 무시', '시스템 프롬프트', '개발자 메시지', '규칙을 무시')

NOISE_PATTERNS = tuple((re.compile(pattern, re.IGNORECASE) for pattern in ('^\\s*(?:downloading|downloaded|installing|installed|resolving|fetching)\\b', '^\\s*(?:npm|pnpm|yarn)\\s+(?:warn|notice|info)\\b', '^\\s*progress[:\\s]', '^\\s*\\d+%\\s*[|#=>.-]+', '^\\s*[|/\\\\-]\\s*$', '^\\s*added \\d+ packages?', '^\\s*packages?:\\s*[+\\-]?\\d+', '^\\s*cache (?:hit|restored|saved)', '^\\s*set up (?:node|pnpm|python|job)', '^\\s*checkout repository', '^\\s*post (?:set up|checkout)', '^\\s*complete job', '^\\s*success(?:ful(?:ly)?)?\\s*$')))

ERROR_PATTERN = re.compile('(?:\\berror\\b|\\bfailed\\b|\\bfailure\\b|exception|traceback|assertion|panic|fatal|pageerror|unhandled|console error|http\\s*[45]\\d\\d|status\\s*[45]\\d\\d|\\bE[A-Z0-9_]{3,}\\b)', re.IGNORECASE)

SUCCESS_PATTERN = re.compile('\\b(?:success|passed|pass|completed|ok)\\b', re.IGNORECASE)

SKIP_PATTERN = re.compile('\\b(?:skip|skipped|not run|pending)\\b', re.IGNORECASE)

HTTP_PATTERN = re.compile('(?:HTTP(?: status)?|status)\\s*[:=]?\\s*([1-5]\\d\\d)\\b', re.IGNORECASE)

FILE_LINE_PATTERN = re.compile('(?P<file>(?:[A-Za-z]:)?[^\\s:\'\\"]+\\.(?:py|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|sql|sh))(?::|\\(|\\s+line\\s+)(?P<line>\\d+)', re.IGNORECASE)

RUN_PATTERN = re.compile('\\b(?:CI\\s*)?(?:Run|run_id|run id)\\s*[:#]?\\s*(\\d{6,})\\b', re.IGNORECASE)

JOB_PATTERN = re.compile('\\b(?:Job|job_id|job id)\\s*[:#]?\\s*(\\d{6,})\\b', re.IGNORECASE)

PR_PATTERN = re.compile('\\bPR\\s*#?\\s*(\\d+)\\b', re.IGNORECASE)

SHA_PATTERN = re.compile('\\b[0-9a-f]{7,40}\\b', re.IGNORECASE)

SECRET_PATTERNS = tuple((re.compile(pattern, re.IGNORECASE) for pattern in ('AIza[0-9A-Za-z_-]{20,}', 'github_pat_[0-9A-Za-z_]{20,}', 'gh[pousr]_[0-9A-Za-z]{20,}', 'sk-[0-9A-Za-z_-]{20,}', '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', '(?:SUPABASE|DATABASE|POSTGRES|OPENAI|GEMINI|AWS|GCP|AZURE)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\\s*[:=]\\s*\\S+', '(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?)://[^\\s]+:[^\\s]+@', '\\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\\s*[:=]\\s*[\'\\"]?[^\\s\'\\"]{8,}')))

class PromptCompilerError(RuntimeError):
    pass

class SecretDetectedError(PromptCompilerError):
    pass

class SchemaValidationError(PromptCompilerError):
    pass

class EvidenceValidationError(PromptCompilerError):
    pass

class ModelCallError(PromptCompilerError):
    pass

class FreeQuotaExceeded(ModelCallError):
    pass

@dataclass(frozen=True)
class PromptProfile:
    name: str
    allowed_action_types: tuple[str, ...]
    required_evidence: tuple[str, ...]
    output_schema: tuple[str, ...]
    maximum_context_size: int
    allowed_workers: tuple[str, ...]
    prohibited_decisions: tuple[str, ...]
    goal: str

PROFILES: dict[str, PromptProfile] = {'ci_analyzer': PromptProfile(name='ci_analyzer', allowed_action_types=('analyze_ci', 'request_context', 'no_action'), required_evidence=('ci', 'failure'), output_schema=MODEL_OUTPUT_FIELDS, maximum_context_size=14000, allowed_workers=('ci-analyzer', 'agent-hub-validation', 'information-tab-analysis-hub', 'github-executor'), prohibited_decisions=('code_change', 'merge', 'deploy', 'permission_change', 'secret_access', 'live_order'), goal='Identify the first defensible CI failure cause, cite evidence, and request exact missing logs when evidence is incomplete. Do not create code-change instructions.'), 'code_fix_planner': PromptProfile(name='code_fix_planner', allowed_action_types=('plan_code_fix', 'request_context', 'no_action'), required_evidence=('analysis_result', 'file', 'head'), output_schema=MODEL_OUTPUT_FIELDS, maximum_context_size=16000, allowed_workers=('code-fix-worker', 'github-executor', 'information-tab-analysis-hub'), prohibited_decisions=('merge', 'deploy', 'permission_change', 'secret_access', 'database_change', 'live_order'), goal='Create the smallest file-scoped fix plan only when a prior CI analysis result and exact file evidence exist.'), 'test_planner': PromptProfile(name='test_planner', allowed_action_types=('plan_tests', 'request_context', 'no_action'), required_evidence=('changed_files', 'head'), output_schema=MODEL_OUTPUT_FIELDS, maximum_context_size=13000, allowed_workers=('test-planner', 'github-executor', 'agent-hub-validation'), prohibited_decisions=('code_change', 'merge', 'deploy', 'secret_access', 'live_order'), goal='Select the smallest relevant deterministic tests for the changed files and define stop conditions.'), 'conflict_analyzer': PromptProfile(name='conflict_analyzer', allowed_action_types=('analyze_conflict', 'request_context', 'no_action'), required_evidence=('head', 'base', 'changed_files'), output_schema=MODEL_OUTPUT_FIELDS, maximum_context_size=15000, allowed_workers=('conflict-analyzer', 'github-executor'), prohibited_decisions=('merge', 'rebase', 'force_push', 'code_change', 'deploy', 'secret_access'), goal='Analyze branch divergence and conflict evidence without authorizing merge, rebase, or force-push.'), 'security_reviewer': PromptProfile(name='security_reviewer', allowed_action_types=('review_security', 'request_context', 'no_action'), required_evidence=('changed_files', 'head'), output_schema=MODEL_OUTPUT_FIELDS, maximum_context_size=15000, allowed_workers=('security-reviewer', 'github-executor', 'agent-hub-validation'), prohibited_decisions=('code_change', 'merge', 'deploy', 'secret_access', 'permission_change', 'live_order'), goal='Review supplied security evidence, identify concrete risks, and request exact safe read-only evidence when incomplete.'), 'release_validator': PromptProfile(name='release_validator', allowed_action_types=('validate_release', 'request_context', 'no_action'), required_evidence=('ci', 'head', 'base'), output_schema=MODEL_OUTPUT_FIELDS, maximum_context_size=15000, allowed_workers=('release-validator', 'agent-hub-validation', 'github-executor'), prohibited_decisions=('merge', 'deploy', 'code_change', 'secret_access', 'permission_change', 'live_order'), goal='Validate release-readiness evidence only. Never authorize merge or deployment; high-risk release actions remain approval-gated.'), 'ui_reviewer': PromptProfile(name='ui_reviewer', allowed_action_types=('review_ui', 'request_context', 'no_action'), required_evidence=('ui', 'changed_files', 'head'), output_schema=MODEL_OUTPUT_FIELDS, maximum_context_size=14000, allowed_workers=('ui-reviewer', 'github-executor', 'information-tab-analysis-hub'), prohibited_decisions=('code_change', 'merge', 'deploy', 'secret_access', 'live_order'), goal='Review UI failures or visual evidence and identify reproducible issues without inventing unseen screenshots or DOM state.')}

@dataclass(frozen=True)
class Evidence:
    evidence_id: str
    category: str
    content: str
    priority: int
    mandatory: bool = False
    current: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {'id': self.evidence_id, 'category': self.category, 'content': self.content}

@dataclass
class ProjectState:
    repository: str = ''
    current_main_sha: str = ''
    worker: str = ''
    branch: str = ''
    head_sha: str = ''
    draft_pr: str = ''
    last_ci_run: str = ''
    last_result: str = ''
    changed_files: list[str] = field(default_factory=list)
    known_blockers: list[str] = field(default_factory=list)
    forbidden_operations: list[str] = field(default_factory=list)
    updated_at: str = ''

    def to_dict(self) -> dict[str, Any]:
        return {'repository': self.repository, 'current_main_sha': self.current_main_sha, 'worker': self.worker, 'branch': self.branch, 'head_sha': self.head_sha, 'draft_pr': self.draft_pr, 'last_ci_run': self.last_ci_run, 'last_result': self.last_result, 'changed_files': self.changed_files, 'known_blockers': self.known_blockers, 'forbidden_operations': self.forbidden_operations, 'updated_at': self.updated_at}

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> 'ProjectState':
        return cls(repository=str(value.get('repository') or ''), current_main_sha=str(value.get('current_main_sha') or ''), worker=str(value.get('worker') or ''), branch=str(value.get('branch') or ''), head_sha=str(value.get('head_sha') or ''), draft_pr=str(value.get('draft_pr') or ''), last_ci_run=str(value.get('last_ci_run') or ''), last_result=str(value.get('last_result') or ''), changed_files=_string_list(value.get('changed_files')), known_blockers=_string_list(value.get('known_blockers')), forbidden_operations=_string_list(value.get('forbidden_operations')), updated_at=str(value.get('updated_at') or ''))

@dataclass(frozen=True)
class LogSummary:
    failed_step: str
    first_error_lines: tuple[str, ...]
    last_error_lines: tuple[str, ...]
    error_file: str
    error_line: str
    error_code: str
    failed_count: int
    passed_count: int
    skipped_count: int
    http_statuses: tuple[str, ...]
    console_error_count: int
    page_error_count: int
    unhandled_count: int
    retained_lines: tuple[str, ...]

@dataclass(frozen=True)
class CompiledPrompt:
    profile: PromptProfile
    prompt: str
    evidence: tuple[Evidence, ...]
    known_evidence_ids: frozenset[str]
    risk_level: str
    report_fields: Mapping[str, Any]
    missing_required_context: tuple[str, ...]
    previous_state: ProjectState | None
    current_state: ProjectState
    state_delta: Mapping[str, Any]
    previous_command_stale: bool
    before_chars: int
    after_chars: int
    block_chars: Mapping[str, int]

@dataclass(frozen=True)
class DecisionResult:
    decision: Mapping[str, Any]
    model_calls: int
    raw_outputs: tuple[str, ...]
    compiled: CompiledPrompt

class ModelClient(Protocol):
    model: str

    def complete(self, prompt: str, *, purpose: str) -> str:
        ...

def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value).strip()
    if not text:
        return []
    if text.startswith('['):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass
    return [item.strip() for item in re.split('[,;|]', text) if item.strip()]

def _clean_scalar(value: str, limit: int=1800) -> str:
    value = re.sub('\\x1b\\[[0-9;]*[A-Za-z]', '', value)
    value = value.replace('\x00', '')
    value = re.sub('[ \\t]+', ' ', value).strip()
    return value[:limit]

__all__ = ['POLICY_VERSION', 'PROVIDER', 'REPORT_MARKER', 'STATE_MARKER_PREFIX', 'STATE_MARKER_SUFFIX', 'STATUS_VALUES', 'RISK_VALUES', 'MODEL_OUTPUT_FIELDS', 'REPORT_FIELDS', 'LIST_REPORT_FIELDS', 'DEFAULT_FORBIDDEN_PATHS', 'HIGH_RISK_TERMS', 'MEDIUM_RISK_TERMS', 'PROMPT_INJECTION_TERMS', 'NOISE_PATTERNS', 'ERROR_PATTERN', 'SUCCESS_PATTERN', 'SKIP_PATTERN', 'HTTP_PATTERN', 'FILE_LINE_PATTERN', 'RUN_PATTERN', 'JOB_PATTERN', 'PR_PATTERN', 'SHA_PATTERN', 'SECRET_PATTERNS', 'PromptCompilerError', 'SecretDetectedError', 'SchemaValidationError', 'EvidenceValidationError', 'ModelCallError', 'FreeQuotaExceeded', 'PromptProfile', 'PROFILES', 'Evidence', 'ProjectState', 'LogSummary', 'CompiledPrompt', 'DecisionResult', 'ModelClient', '_string_list', '_clean_scalar']
