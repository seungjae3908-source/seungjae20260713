#!/usr/bin/env python3
from __future__ import annotations
import json
import re
from typing import Any, Mapping, Sequence
from agent_hub_prompt_types import (DEFAULT_FORBIDDEN_PATHS, HIGH_RISK_TERMS, MODEL_OUTPUT_FIELDS, POLICY_VERSION, PROVIDER, STATUS_VALUES, RISK_VALUES, CompiledPrompt, DecisionResult, EvidenceValidationError, FreeQuotaExceeded, ModelCallError, ModelClient, ProjectState, SchemaValidationError, _clean_scalar, _string_list)
from agent_hub_prompt_report import _required_categories_present, state_marker
from agent_hub_prompt_compiler import _deterministic_blocked_decision, _deterministic_missing_decision, _deterministic_no_action

def parse_model_json(raw: str) -> dict[str, Any]:
    if not raw or len(raw) > 12000:
        raise SchemaValidationError('model output is empty or too large')
    stripped = raw.strip()
    if stripped.startswith('```') or not (stripped.startswith('{') and stripped.endswith('}')):
        raise SchemaValidationError('model output must be exactly one JSON object')
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise SchemaValidationError(f'model output is not valid JSON: {exc}') from exc
    if not isinstance(value, dict):
        raise SchemaValidationError('model output must be a JSON object')
    expected = set(MODEL_OUTPUT_FIELDS)
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise SchemaValidationError(f'schema fields mismatch; missing={missing}; extra={extra}')
    return value

def _validate_string_list(value: Any, field_name: str) -> list[str]:
    if not isinstance(value, list) or any((not isinstance(item, str) for item in value)):
        raise SchemaValidationError(f'{field_name} must be a list of strings')
    return [item.strip() for item in value if item.strip()]

def validate_decision(decision: Mapping[str, Any], compiled: CompiledPrompt, *, model: str) -> dict[str, Any]:
    result = dict(decision)
    for field_name in MODEL_OUTPUT_FIELDS:
        if field_name not in result:
            raise SchemaValidationError(f'missing required field: {field_name}')
    for field_name in ('status', 'action_type', 'target_worker', 'risk_level', 'summary', 'reason', 'safe_read_only_command', 'repository', 'branch', 'base_sha', 'expected_head_sha', 'instruction', 'validation', 'stop_conditions', 'provider', 'model', 'policy_version'):
        if not isinstance(result[field_name], str):
            raise SchemaValidationError(f'{field_name} must be a string')
        result[field_name] = result[field_name].strip()
    for field_name in ('evidence_ids', 'assumptions', 'missing_context', 'exact_files_or_logs_needed', 'allowed_paths', 'forbidden_paths'):
        result[field_name] = _validate_string_list(result[field_name], field_name)
    if not isinstance(result['requires_user_approval'], bool):
        raise SchemaValidationError('requires_user_approval must be boolean')
    if not isinstance(result['confidence'], (int, float)) or isinstance(result['confidence'], bool):
        raise SchemaValidationError('confidence must be numeric')
    result['confidence'] = max(0.0, min(1.0, float(result['confidence'])))
    if result['status'] not in STATUS_VALUES:
        raise SchemaValidationError('invalid status')
    if result['risk_level'] not in RISK_VALUES:
        raise SchemaValidationError('invalid risk_level')
    if result['action_type'] not in compiled.profile.allowed_action_types:
        raise SchemaValidationError('action_type is not allowed for profile')
    if result['target_worker'] not in set(compiled.profile.allowed_workers) | {'none'}:
        raise SchemaValidationError('target_worker is not allowed for profile')
    unknown = sorted(set(result['evidence_ids']) - compiled.known_evidence_ids)
    if unknown:
        raise EvidenceValidationError('unknown evidence_ids: ' + ', '.join(unknown))
    if result['provider'] != PROVIDER or result['model'] != model or result['policy_version'] != POLICY_VERSION:
        raise SchemaValidationError('provider/model/policy_version mismatch')
    if result['risk_level'] != compiled.risk_level:
        raise SchemaValidationError('model risk_level disagrees with Python policy')
    fields = compiled.report_fields
    if result['repository'] != fields.get('repository', ''):
        raise SchemaValidationError('repository mismatch')
    if result['branch'] != fields.get('branch', ''):
        raise SchemaValidationError('branch mismatch')
    if result['base_sha'] != fields.get('base_sha', ''):
        raise SchemaValidationError('base_sha mismatch')
    if result['expected_head_sha'] != fields.get('head_sha', ''):
        raise SchemaValidationError('expected_head_sha mismatch')
    if result['branch'].lower() in {'main', 'master'} and result['status'] == 'ready':
        raise SchemaValidationError('ready on main/master is forbidden')
    if result['status'] == 'needs_context':
        if not result['missing_context'] or not result['reason'] or (not result['exact_files_or_logs_needed']) or (not result['safe_read_only_command']):
            raise SchemaValidationError('needs_context requires missing_context, reason, exact_files_or_logs_needed, and safe_read_only_command')
        if result['action_type'] != 'request_context':
            raise SchemaValidationError('needs_context must use request_context')
    elif result['missing_context'] and result['status'] == 'ready':
        raise SchemaValidationError('ready cannot include missing_context')
    if compiled.profile.name == 'ci_analyzer' and result['action_type'] not in {'analyze_ci', 'request_context', 'no_action'}:
        raise SchemaValidationError('ci_analyzer cannot create a code fix command')
    if compiled.profile.name == 'code_fix_planner' and 'analysis_result' not in _required_categories_present(compiled.evidence):
        raise SchemaValidationError('code_fix_planner requires prior ci_analyzer evidence')
    result['forbidden_paths'] = sorted(set(result['forbidden_paths']) | set(DEFAULT_FORBIDDEN_PATHS))
    for path in result['allowed_paths']:
        if path.startswith('/') or '..' in path.split('/'):
            raise SchemaValidationError('unsafe allowed path')
        if any((_glob_overlap(path, forbidden) for forbidden in DEFAULT_FORBIDDEN_PATHS)):
            raise SchemaValidationError('allowed path overlaps a forbidden path')
    return result

def _glob_overlap(path: str, forbidden: str) -> bool:
    plain_forbidden = forbidden.replace('**', '').replace('*', '').strip('/')
    plain_path = path.replace('**', '').replace('*', '').strip('/')
    return bool(plain_forbidden and (plain_path.startswith(plain_forbidden) or plain_forbidden.startswith(plain_path)))

def apply_python_policy(decision: dict[str, Any], compiled: CompiledPrompt) -> dict[str, Any]:
    result = dict(decision)
    fields = compiled.report_fields
    result['provider'] = PROVIDER
    result['policy_version'] = POLICY_VERSION
    result['risk_level'] = compiled.risk_level
    result['repository'] = fields.get('repository', '')
    result['branch'] = fields.get('branch', '')
    result['base_sha'] = fields.get('base_sha', '')
    result['expected_head_sha'] = fields.get('head_sha', '')
    result['forbidden_paths'] = sorted(set(_string_list(result.get('forbidden_paths'))) | set(DEFAULT_FORBIDDEN_PATHS))
    approval_requested = str(fields.get('approval_required', '')).lower() in {'yes', 'true', 'required', '1'}
    combined = '\n'.join((str(result.get(key, '')) for key in ('summary', 'reason', 'instruction', 'validation'))).lower()
    dangerous = any((term.lower() in combined for term in HIGH_RISK_TERMS))
    if compiled.risk_level == 'high' or approval_requested or dangerous:
        result['status'] = 'waiting_approval' if fields.get('branch', '').lower() not in {'main', 'master'} else 'blocked'
        result['requires_user_approval'] = True
        result['action_type'] = 'request_context' if 'request_context' in compiled.profile.allowed_action_types else 'no_action'
        result['target_worker'] = 'none'
        result['allowed_paths'] = []
        result['instruction'] = '고위험 작업은 분석 결과만 보존하고 사용자 승인 전 실행 명령을 생성하지 않는다.'
        result['stop_conditions'] = '사용자 명시 승인 전 즉시 중단'
    if compiled.previous_command_stale:
        result['assumptions'] = [item for item in _string_list(result.get('assumptions')) if 'previous command' not in item.lower()]
    return result

def decisions_agree(first: Mapping[str, Any], second: Mapping[str, Any]) -> bool:
    critical = ('status', 'action_type', 'target_worker', 'risk_level', 'repository', 'branch', 'base_sha', 'expected_head_sha', 'allowed_paths', 'forbidden_paths', 'requires_user_approval')
    return all((first.get(key) == second.get(key) for key in critical))

def _report_is_deterministic_no_action(fields: Mapping[str, Any]) -> bool:
    status = str(fields.get('status', '')).lower()
    next_needed = str(fields.get('next_needed', '')).strip().lower()
    return status in {'completed', 'success', 'done'} and next_needed in {'', 'none', 'no_action', '없음'}

def decide(compiled: CompiledPrompt, client: ModelClient) -> DecisionResult:
    model = client.model
    if compiled.missing_required_context and compiled.risk_level == 'high':
        decision = _deterministic_blocked_decision(compiled, model, 'high-risk task lacks required evidence; analysis cannot safely continue', [item.evidence_id for item in compiled.evidence if item.mandatory])
        return DecisionResult(decision, 0, (), compiled)
    if compiled.missing_required_context:
        decision = _deterministic_missing_decision(compiled, model, 'profile required evidence is missing', compiled.missing_required_context)
        return DecisionResult(decision, 0, (), compiled)
    if _report_is_deterministic_no_action(compiled.report_fields):
        return DecisionResult(_deterministic_no_action(compiled, model), 0, (), compiled)
    call_count = 1 if compiled.risk_level in {'low', 'high'} else 2
    raw_outputs: list[str] = []
    validated: list[dict[str, Any]] = []
    try:
        for index in range(call_count):
            purpose = 'analysis' if index == 0 else 'independent_verification'
            raw = client.complete(compiled.prompt, purpose=purpose)
            raw_outputs.append(raw)
            parsed = parse_model_json(raw)
            candidate = validate_decision(parsed, compiled, model=model)
            validated.append(candidate)
    except FreeQuotaExceeded as exc:
        decision = _deterministic_blocked_decision(compiled, model, f'free quota exceeded; no paid fallback and no automatic retry: {exc}')
        return DecisionResult(decision, len(raw_outputs) + 1, tuple(raw_outputs), compiled)
    except (ModelCallError, SchemaValidationError, EvidenceValidationError) as exc:
        decision = _deterministic_blocked_decision(compiled, model, f'fail-closed model validation: {exc}')
        return DecisionResult(decision, len(raw_outputs) + (0 if raw_outputs else 1), tuple(raw_outputs), compiled)
    if call_count == 2 and (not decisions_agree(validated[0], validated[1])):
        decision = _deterministic_missing_decision(compiled, model, 'independent medium-risk model results disagreed on critical fields', ('independent agreement on status, action, branch, HEAD, paths, and approval',))
        return DecisionResult(decision, 2, tuple(raw_outputs), compiled)
    decision = apply_python_policy(validated[0], compiled)
    try:
        decision = validate_decision(decision, compiled, model=model)
    except (SchemaValidationError, EvidenceValidationError) as exc:
        decision = _deterministic_blocked_decision(compiled, model, f'post-policy validation failed: {exc}')
    return DecisionResult(decision, call_count, tuple(raw_outputs), compiled)

def command_lines(*, source_task_id: str, report_comment_id: int, decision: Mapping[str, Any], state: ProjectState) -> str:
    execution_mode = 'approval_only'
    if decision['status'] == 'ready':
        execution_mode = 'code_change' if decision['action_type'] == 'plan_code_fix' else 'read_only'
    ordered = ['status', 'action_type', 'target_worker', 'risk_level', 'summary', 'evidence_ids', 'assumptions', 'missing_context', 'reason', 'exact_files_or_logs_needed', 'safe_read_only_command', 'repository', 'branch', 'base_sha', 'expected_head_sha', 'allowed_paths', 'forbidden_paths', 'instruction', 'validation', 'stop_conditions', 'requires_user_approval', 'confidence', 'provider', 'model', 'policy_version']
    lines = ['[HUB_COMMAND]', f'source_task_id: {_clean_scalar(source_task_id, 160)}']
    for key in ordered:
        value = decision[key]
        if isinstance(value, (list, dict)):
            rendered = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        elif isinstance(value, bool):
            rendered = 'true' if value else 'false'
        else:
            rendered = re.sub('\\s+', ' ', str(value)).strip()
        lines.append(f'{key}: {rendered}')
    lines.extend([f'execution_mode: {execution_mode}', f'processed_report_comment_id: {report_comment_id}', state_marker(state), f'<!-- agent-hub-processed:{report_comment_id} -->'])
    return '\n'.join(lines)

def compression_metrics(compiled: CompiledPrompt, model_calls: int) -> dict[str, Any]:
    before = compiled.before_chars
    after = compiled.after_chars
    reduction = 0.0 if before <= 0 else round((1 - after / before) * 100, 2)
    return {'profile': compiled.profile.name, 'context_before_chars': before, 'evidence_after_chars': after, 'compiled_prompt_chars': len(compiled.prompt), 'reduction_percent': reduction, 'block_chars': dict(compiled.block_chars), 'model_calls': model_calls, 'maximum_context_size': compiled.profile.maximum_context_size, 'evidence_count': len(compiled.evidence)}
__all__ = ['apply_python_policy', 'command_lines', 'compression_metrics', 'decide', 'decisions_agree', 'parse_model_json', 'validate_decision']
