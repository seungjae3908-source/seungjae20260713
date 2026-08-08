#!/usr/bin/env python3
"""Safety adapter for the schema-v2 coordinator with immutable GitHub evidence."""
from __future__ import annotations

import argparse
import json
import os
import re
from typing import Any, Mapping, Sequence

import agent_hub_coordinator_v2 as core
from agent_hub_command_integrity_v2 import seal_command_body
from agent_hub_github_validation_v2 import (
    GitHubEvidenceError,
    ValidatedGitHubEvidence,
    fetch_pull_request,
    validate_report_evidence,
)
from agent_hub_prompt_compiler_hardening_v2 import (
    HardenedCompiledPrompt,
    PromptHardeningError,
    compile_prompt,
    decisions_agree,
    parse_model_proposal,
)
from agent_hub_security_v2 import SensitiveDataError, safe_blocked_comment, sanitize_report_for_model_strict
from agent_hub_state_v2 import format_state_snapshot


class HardeningError(RuntimeError):
    pass


REQUIRED_SCHEMA_V2_REPORT_FIELDS = (
    "schema_version", "task_id", "root_task_id", "worker", "repository", "base_branch", "base_sha",
    "branch", "status", "head_sha", "pr_number", "changed_files", "checks", "ci_run_id", "summary",
    "remaining", "dependencies", "conflicts", "approval_required", "prohibited_actions_confirmed",
)
LOW_RISK_AUTO_ACTIONS = frozenset({
    "inspect_repository", "inspect_branch", "inspect_pull_request", "analyze_ci_failure", "analyze_logs",
    "analyze_playwright_trace", "modify_feature_branch", "add_or_update_tests", "run_typecheck",
    "run_unit_tests", "run_build", "run_playwright", "create_draft_pr", "update_draft_pr_description",
    "report_results", "analyze_conflicts", "create_integration_plan", "inspect_security_contract",
    "inspect_private_api_calls", "inspect_paper_vs_live_order_separation",
})
NO_PROGRESS_REPEAT_LIMIT = 3
SAFE_AUDIT_TOKEN_RE = re.compile(r"^[A-Za-z0-9._:-]{1,180}$")
POLICY_ERROR_PATTERNS = (
    (re.compile(r"^(?P<field>[a-z_]+) must be a non-empty array$"), "empty_list_not_allowed"),
    (re.compile(r"^(?P<field>[a-z_]+) must be an array$"), "invalid_list_type"),
    (re.compile(r"^(?P<field>[a-z_]+) must be a JSON array$"), "malformed_json_array"),
    (re.compile(r"^(?P<field>[a-z_]+) must be valid JSON$"), "malformed_json_array"),
    (re.compile(r"^(?P<field>[a-z_]+) contains a non-string path pattern$"), "invalid_path_type"),
    (re.compile(r"^(?P<field>[a-z_]+) contains an invalid path pattern$"), "invalid_path_pattern"),
    (re.compile(r"^(?P<field>[a-z_]+) cannot contain parent traversal$"), "parent_traversal"),
)


def requires_independent_verification(risk_level: str) -> bool:
    return risk_level == "medium"


def _comment_for_report(comments: Sequence[Mapping[str, Any]], report_id: int) -> Mapping[str, Any]:
    return next((item for item in comments if int(item.get("id") or 0) == report_id), {})


def _unique_ids(*groups: Sequence[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(item for group in groups for item in group if str(item).strip()))


def _safe_audit_token(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text if SAFE_AUDIT_TOKEN_RE.fullmatch(text) else fallback


def _safe_model_action(raw: str) -> str:
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return "unknown"
    if not isinstance(payload, dict):
        return "unknown"
    return _safe_audit_token(payload.get("action_type"), "unknown")


def _sanitized_policy_error(
    exc: core.PolicyError,
    *,
    validation_stage: str,
    action: str,
    task_id: str,
) -> dict[str, Any]:
    field = "unknown"
    reason = "policy_validation_failed"
    message = str(exc)
    for pattern, mapped_reason in POLICY_ERROR_PATTERNS:
        match = pattern.fullmatch(message)
        if match:
            field = _safe_audit_token(match.group("field"), "unknown")
            reason = mapped_reason
            break
    return {
        "error_type": "PolicyError",
        "validation_stage": _safe_audit_token(validation_stage, "unknown"),
        "field": field,
        "reason": reason,
        "action": _safe_audit_token(action, "unknown"),
        "task_id": _safe_audit_token(task_id, "unknown"),
        "safe_to_retry": False,
    }


def _audit_instruction(audit: Mapping[str, Any]) -> str:
    return "; ".join(
        [
            "error_code=model_validation_failed",
            f"error_type={audit['error_type']}",
            f"validation_stage={audit['validation_stage']}",
            f"field={audit['field']}",
            f"reason={audit['reason']}",
            f"action={audit['action']}",
            f"task_id={audit['task_id']}",
            f"safe_to_retry={'true' if audit['safe_to_retry'] else 'false'}",
        ]
    )


def _post_sealed_command(github: Any, issue_number: int, body: str, compiled: HardenedCompiledPrompt | None = None) -> str:
    if compiled is not None:
        body = body.rstrip() + "\n" + format_state_snapshot(compiled.current_state)
    sealed = seal_command_body(body)
    github.post_comment(issue_number, sealed)
    return sealed


def _set_no_run(model_calls: int = 0) -> None:
    core.set_output("executor_ready", "false")
    core.set_output("model_calls", str(model_calls))


def _generic_status(
    *, github: Any, issue_number: int, report: Any, policy: Mapping[str, Any], status: str,
    risk: str, instruction: str, auto_step: int, approval_required: bool = False,
    compiled: HardenedCompiledPrompt | None = None, evidence_ids: Sequence[str] = (),
    reason: str | None = None, model_calls: int = 0, audit: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    compiled_ids = tuple(item.evidence_id for item in compiled.evidence if item.mandatory) if compiled else ()
    verified_ids = _unique_ids(evidence_ids, compiled_ids)
    body = core.deterministic_status_command(
        report=report, policy=policy, status=status, risk=risk, instruction=instruction,
        evidence_ids=verified_ids, auto_step=auto_step, approval_required=approval_required,
    )
    _post_sealed_command(github, issue_number, body, compiled)
    _set_no_run(model_calls)
    result: dict[str, Any] = {
        "status": status,
        "reason": reason or status,
        "model_calls": model_calls,
        "evidence_ids": list(verified_ids),
    }
    if audit is not None:
        result["validation_error"] = dict(audit)
    return result


def _raw_required_field_errors(report: Any) -> tuple[str, ...]:
    raw = core.parse_key_values(report.raw_body)
    return tuple(field for field in REQUIRED_SCHEMA_V2_REPORT_FIELDS if field not in raw or not str(raw[field]).strip())


def _validate_named_pr(report: Any, github: Any) -> int:
    text = str(report.fields.get("pr_number") or "none").strip().lower()
    if text == "none":
        return 0
    if not text.isdigit():
        raise GitHubEvidenceError("pr_number_invalid", "pull_request", "positive integer", text)
    evidence = fetch_pull_request(github, int(text))
    if evidence.repository != github.repository or evidence.state != "open" or evidence.merged:
        raise GitHubEvidenceError("pr_not_open", "pull_request", "open same-repository PR", {"repository": evidence.repository, "state": evidence.state, "merged": evidence.merged})
    if evidence.base_branch != report.fields.get("base_branch"):
        raise GitHubEvidenceError("pr_base_branch_mismatch", "pull_request", report.fields.get("base_branch"), evidence.base_branch)
    expected_head_branch = report.fields.get("target_branch") or report.branch
    if expected_head_branch != report.branch or evidence.head_branch != report.branch or evidence.head_sha != report.head_sha:
        raise GitHubEvidenceError(
            "pr_head_identity_mismatch", "pull_request",
            {"branch": report.branch, "sha": report.head_sha},
            {"target_branch": expected_head_branch, "branch": evidence.head_branch, "sha": evidence.head_sha},
        )
    return evidence.number


def _normalize_failure_signature(fields: Mapping[str, Any]) -> str:
    raw = str(fields.get("failure_signature") or "").strip()
    if not raw:
        raw = str(fields.get("checks") or "").strip()
    return re.sub(r"\b\d+\b", "#", re.sub(r"\s+", " ", raw).casefold())[:320]


def _failure_repeat_count(comments: Sequence[Mapping[str, Any]], report: Any) -> int:
    if report.status != "failed":
        return 0
    signature = _normalize_failure_signature(report.fields)
    if not signature:
        return 0
    count = 1
    for comment in comments:
        if int(comment.get("id") or 0) == report.comment_id or not core.trusted_report_comment(comment):
            continue
        fields = core.parse_key_values(str(comment.get("body") or ""))
        other_root = fields.get("root_task_id") or fields.get("task_id")
        if (
            other_root == report.root_task_id
            and fields.get("status") == "failed"
            and fields.get("branch") == report.branch
            and fields.get("head_sha") == report.head_sha
            and _normalize_failure_signature(fields) == signature
        ):
            count += 1
    return count


def _same_ready_command_repeat_count(
    comments: Sequence[Mapping[str, Any]], report: Any, command_fields: Mapping[str, Any],
) -> int:
    count = 1
    for fields in core.prior_task_commands(comments, report.root_task_id):
        if (
            fields.get("status") == "ready"
            and fields.get("target_worker") == command_fields.get("target_worker")
            and fields.get("action_type") == command_fields.get("action_type")
            and fields.get("target_branch") == command_fields.get("target_branch")
            and fields.get("expected_head_sha") == command_fields.get("expected_head_sha")
        ):
            count += 1
    return count


def _evaluate(policy: dict[str, Any], workers: dict[str, Any], repository: str, report: Any, comments: Sequence[Mapping[str, Any]], proposed: Any) -> Any:
    current_sha = report.head_sha if report.head_sha != "none" else report.fields["base_sha"]
    if current_sha == "none":
        current_sha = "0" * 40
    return core.evaluate_proposal(
        proposal=proposed.proposal, policy=policy, workers=workers, repository=repository,
        task_id=report.root_task_id, report_comment_id=report.comment_id, report_head_sha=current_sha,
        base_sha=report.fields["base_sha"] if report.fields["base_sha"] != "none" else current_sha,
        current_branch_sha=current_sha,
        running_command_id=core.running_command_for_worker(comments, proposed.proposal.target_worker),
        repeated_failure=False,
        superseded_command_id=core.superseded_candidate(comments, report.root_task_id),
    )


def _conflicting_files(github: Any, report: Any, proposal: Any, decision: Any, validated: ValidatedGitHubEvidence) -> list[str]:
    if decision.fields["status"] != "ready" or decision.fields["action_type"] not in {"modify_feature_branch", "add_or_update_tests"}:
        return []
    current_pr = validated.pr.number if validated.pr else _validate_named_pr(report, github)
    owners = github.open_pr_file_owners()
    conflicts: list[str] = []
    for pr_number, files in owners.items():
        if pr_number != current_pr:
            conflicts.extend(core.any_file_overlap(list(proposal.proposal.allowed_paths), files))
    return sorted(dict.fromkeys(conflicts))


def process_once(*, github: Any, gemini: Any, issue_number: int, repository: str) -> dict[str, Any]:
    policy = core.load_policy()
    workers = core.load_workers()
    if tuple(sorted(workers)) != tuple(sorted(core.WORKER_IDS)):
        raise HardeningError("worker registry does not match schema-v2 role contract")
    comments = github.list_issue_comments(issue_number)
    expired_count = core.expire_v2_commands(comments, github, issue_number)
    report, invalid_reports = core.latest_pending_report(comments, repository=repository, workers=workers)
    if report is None:
        _set_no_run(0)
        if invalid_reports:
            return {"status": "needs_context", "reason": "invalid_report_schema", "details": list(invalid_reports), "model_calls": 0}
        return {"status": "no_pending_report", "expired_commands": expired_count, "model_calls": 0}

    missing_fields = _raw_required_field_errors(report)
    if missing_fields:
        return _generic_status(
            github=github, issue_number=issue_number, report=report, policy=policy, status="needs_context",
            risk="medium", instruction="error_code=report_required_fields_missing; stage=report_schema; expected=all required schema-v2 fields; actual=missing " + ",".join(missing_fields) + "; retryable=yes",
            auto_step=0, reason="report_required_fields_missing",
        )

    try:
        sanitized_report, redaction_count = sanitize_report_for_model_strict(report.raw_body)
    except SensitiveDataError:
        github.post_comment(issue_number, safe_blocked_comment(source_report_comment_id=report.comment_id))
        _set_no_run(0)
        return {"status": "blocked", "reason": "sensitive_data_detected", "model_calls": 0, "artifact_saved": False, "paid_fallback": 0}

    if core.duplicate_task_report(comments, report):
        return _generic_status(github=github, issue_number=issue_number, report=report, policy=policy, status="no_action", risk="low", instruction="error_code=duplicate_report; stage=deduplication; expected=new task_id; actual=existing task_id; retryable=no", auto_step=0, reason="duplicate_report")
    prior = core.prior_task_commands(comments, report.root_task_id)
    auto_step = len(prior) + 1

    report_comment = _comment_for_report(comments, report.comment_id)
    try:
        validated = validate_report_evidence(report, github, issue_number=issue_number, report_comment=report_comment)
        _validate_named_pr(report, github)
    except GitHubEvidenceError as exc:
        return _generic_status(
            github=github, issue_number=issue_number, report=report, policy=policy, status="blocked",
            risk="prohibited", instruction=exc.audit_message(), auto_step=auto_step,
            evidence_ids=exc.evidence_ids, reason=exc.code,
        )
    verified_ids = validated.evidence_ids

    if report.status == "waiting_approval" or report.fields["approval_required"] == "yes":
        return _generic_status(github=github, issue_number=issue_number, report=report, policy=policy, status="waiting_approval", risk="high", instruction="error_code=user_approval_required; stage=approval_gate; expected=explicit approval; actual=not approved; retryable=yes", auto_step=auto_step, approval_required=True, evidence_ids=verified_ids, reason="user_approval_required")
    dependencies = report.fields.get("dependencies", "").strip().lower()
    if dependencies not in {"", "none", "[]"}:
        return _generic_status(github=github, issue_number=issue_number, report=report, policy=policy, status="waiting", risk="medium", instruction="error_code=dependencies_unresolved; stage=dependency_gate; expected=none; actual=" + report.fields["dependencies"][:500] + "; retryable=yes", auto_step=auto_step, evidence_ids=verified_ids, reason="dependencies_unresolved")
    remaining = report.fields.get("remaining", "").strip().lower()
    if report.status == "completed" and remaining in {"", "none", "no_action", "없음"}:
        return _generic_status(github=github, issue_number=issue_number, report=report, policy=policy, status="no_action", risk="low", instruction="Completed report has no remaining work; model call skipped.", auto_step=auto_step, evidence_ids=verified_ids, reason="completed_no_remaining")

    failure_repeats = _failure_repeat_count(comments, report)
    if failure_repeats >= NO_PROGRESS_REPEAT_LIMIT:
        return _generic_status(
            github=github, issue_number=issue_number, report=report, policy=policy, status="blocked",
            risk="prohibited",
            instruction=(
                "error_code=no_progress_repeated_failure; stage=progress_guard; expected=HEAD or failure signature to change after a safe retry; "
                f"actual=same HEAD and failure repeated {failure_repeats} times; retryable=no"
            ),
            auto_step=auto_step, evidence_ids=verified_ids, reason="no_progress_repeated_failure",
        )

    fields_for_compiler: dict[str, Any] = dict(report.fields)
    fields_for_compiler["changed_files"] = list(core.parse_json_list(report.fields["changed_files"], "changed_files"))
    try:
        compiled = compile_prompt(
            fields=fields_for_compiler, sanitized_report=sanitized_report,
            allowed_action_types=policy["action_table"].keys(), registered_workers=workers.keys(),
            policy_version=str(policy["policy_version"]), comments=comments,
            updated_at=str(report_comment.get("updated_at") or report_comment.get("created_at") or ""),
        )
    except (PromptHardeningError, core.PromptCompilerError, core.PolicyError) as exc:
        return _generic_status(github=github, issue_number=issue_number, report=report, policy=policy, status="blocked", risk="prohibited", instruction=f"error_code=prompt_compile_failed; stage=prompt_compiler; expected=valid evidence prompt; actual={type(exc).__name__}; retryable=no", auto_step=auto_step, evidence_ids=verified_ids, reason="prompt_compile_failed")
    if compiled.missing_required:
        return _generic_status(github=github, issue_number=issue_number, report=report, policy=policy, status="needs_context", risk="medium", instruction="error_code=mandatory_prompt_evidence_missing; stage=prompt_compiler; expected=mandatory evidence; actual=" + ",".join(compiled.missing_required) + "; retryable=yes", auto_step=auto_step, compiled=compiled, evidence_ids=verified_ids, reason="mandatory_prompt_evidence_missing")

    model_calls = 0
    raw_first = ""
    try:
        raw_first = gemini.complete(compiled.prompt, purpose="analysis")
        model_calls = 1
        first = core.parse_candidate(raw_first, compiled, policy, report)
        first_decision = _evaluate(policy, workers, repository, report, comments, first)
    except core.PolicyError as exc:
        audit = _sanitized_policy_error(
            exc,
            validation_stage="model_proposal",
            action=_safe_model_action(raw_first),
            task_id=report.root_task_id,
        )
        return _generic_status(
            github=github, issue_number=issue_number, report=report, policy=policy, status="blocked",
            risk="prohibited", instruction=_audit_instruction(audit), auto_step=auto_step,
            compiled=compiled, evidence_ids=verified_ids, reason="model_validation_failed",
            model_calls=model_calls, audit=audit,
        )
    except Exception as exc:
        return _generic_status(github=github, issue_number=issue_number, report=report, policy=policy, status="blocked", risk="prohibited", instruction=f"error_code=model_validation_failed; stage=model_proposal; expected=valid free-model proposal; actual={type(exc).__name__}; retryable=no", auto_step=auto_step, compiled=compiled, evidence_ids=verified_ids, reason="model_validation_failed", model_calls=model_calls)
    conflict_files = _conflicting_files(github, report, first, first_decision, validated)
    final_risk = "medium" if conflict_files and first_decision.fields["status"] == "ready" else first_decision.fields["risk_level"]

    if requires_independent_verification(final_risk):
        try:
            raw_second = gemini.complete(compiled.prompt, purpose="independent_verification")
            second = core.parse_candidate(raw_second, compiled, policy, report)
            second_decision = _evaluate(policy, workers, repository, report, comments, second)
            model_calls = 2
            if not decisions_agree(parse_model_proposal(raw_first, compiled), parse_model_proposal(raw_second, compiled)):
                raise HardeningError("independent proposals disagree")
            critical = ("status", "risk_level", "target_worker", "action_type", "branch", "allowed_paths", "forbidden_paths", "expected_head_sha")
            if any(first_decision.fields.get(key) != second_decision.fields.get(key) for key in critical):
                raise HardeningError("independent deterministic decisions disagree")
        except Exception:
            return _generic_status(github=github, issue_number=issue_number, report=report, policy=policy, status="needs_context", risk="medium", instruction="error_code=independent_verification_failed; stage=medium_risk_verification; expected=two matching decisions; actual=disagreement_or_failure; retryable=yes", auto_step=auto_step, compiled=compiled, evidence_ids=_unique_ids(verified_ids, first.evidence_ids), reason="independent_verification_failed", model_calls=model_calls)

    command_evidence_ids = _unique_ids(verified_ids, first.evidence_ids)
    if first_decision.fields["status"] == "ready" and not command_evidence_ids:
        return _generic_status(github=github, issue_number=issue_number, report=report, policy=policy, status="blocked", risk="prohibited", instruction="error_code=immutable_evidence_empty; stage=command_creation; expected=non-empty immutable evidence IDs; actual=[]; retryable=no", auto_step=auto_step, compiled=compiled, reason="immutable_evidence_empty", model_calls=model_calls)

    superseded = core.superseded_candidate(comments, report.root_task_id)
    v2_fields = core.legacy_fields_to_v2(
        report=report, policy=policy, decision_fields=first_decision.fields,
        evidence_ids=command_evidence_ids, auto_step=auto_step, conflict_files=conflict_files,
    )
    if validated.pr is not None and v2_fields["status"] == "ready":
        v2_fields["work_branch"] = report.branch

    if (
        report.fields["approval_required"] == "no"
        and v2_fields["action_type"] in LOW_RISK_AUTO_ACTIONS
        and v2_fields["status"] == "waiting_approval"
    ):
        return _generic_status(
            github=github, issue_number=issue_number, report=report, policy=policy, status="blocked",
            risk="prohibited",
            instruction="error_code=unexpected_low_risk_approval_escalation; stage=approval_integrity; expected=low-risk ready/waiting/blocked decision without user approval; actual=waiting_approval; retryable=no",
            auto_step=auto_step, compiled=compiled, evidence_ids=command_evidence_ids,
            reason="unexpected_low_risk_approval_escalation", model_calls=model_calls,
        )

    if v2_fields["status"] == "ready":
        command_repeats = _same_ready_command_repeat_count(comments, report, v2_fields)
        if command_repeats >= NO_PROGRESS_REPEAT_LIMIT:
            return _generic_status(
                github=github, issue_number=issue_number, report=report, policy=policy, status="blocked",
                risk="prohibited",
                instruction=(
                    "error_code=no_progress_repeated_command; stage=progress_guard; expected=next action or HEAD to change; "
                    f"actual=same ready action on same HEAD repeated {command_repeats} times; retryable=no"
                ),
                auto_step=auto_step, compiled=compiled, evidence_ids=command_evidence_ids,
                reason="no_progress_repeated_command", model_calls=model_calls,
            )

    existing_ids = {fields.get("command_id", "") for fields in core.command_comments(comments)}
    if v2_fields["command_id"] in existing_ids:
        _set_no_run(model_calls)
        return {"status": "no_action", "reason": "duplicate_command_id", "model_calls": model_calls, "evidence_ids": list(command_evidence_ids)}
    if superseded and superseded != v2_fields["command_id"]:
        github.post_comment(issue_number, core.format_state(command_id_value=superseded, source_task_id=report.root_task_id, target_worker=v2_fields["target_worker"], status="superseded", reason="Replaced by a newer schema-v2 command."))
    command_body = core.format_command(v2_fields, policy_version=str(policy["policy_version"]))
    _post_sealed_command(github, issue_number, command_body, compiled)
    executor_ready = v2_fields["status"] == "ready"
    core.set_output("executor_ready", "true" if executor_ready else "false")
    core.set_output("model_calls", str(model_calls))
    core.set_output("command_id", str(v2_fields["command_id"]))
    return {
        "status": v2_fields["status"], "command_id": v2_fields["command_id"], "model_calls": model_calls,
        "redactions": redaction_count, "profile": compiled.profile, "state_delta": compiled.state_delta,
        "conflict_files": conflict_files, "expired_commands": expired_count, "paid_fallback": 0,
        "evidence_ids": list(command_evidence_ids), "evidence_count": len(command_evidence_ids),
        "auto_step": auto_step, "failure_repeats": failure_repeats,
    }


def self_test() -> int:
    body = "[WORKER_REPORT]\nschema_version: 2\ntask_id: task-1\nworker: test-runner"
    fake = type("R", (), {"raw_body": body})()
    assert "root_task_id" in _raw_required_field_errors(fake)
    assert _unique_ids(("a", "b"), ("b", "c")) == ("a", "b", "c")
    assert len(LOW_RISK_AUTO_ACTIONS) == 20
    fields = {"checks": "Assertion line 12 failed", "failure_signature": ""}
    assert _normalize_failure_signature(fields) == "assertion line # failed"

    raw = json.dumps({
        "action_type": "modify_feature_branch",
        "instruction": "do not log AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    })
    audit = _sanitized_policy_error(
        core.PolicyError("allowed_paths must be a non-empty array"),
        validation_stage="model_proposal",
        action=_safe_model_action(raw),
        task_id="agent-hub-audit-test",
    )
    assert audit == {
        "error_type": "PolicyError",
        "validation_stage": "model_proposal",
        "field": "allowed_paths",
        "reason": "empty_list_not_allowed",
        "action": "modify_feature_branch",
        "task_id": "agent-hub-audit-test",
        "safe_to_retry": False,
    }
    audit_text = _audit_instruction(audit) + json.dumps(audit, separators=(",", ":"))
    assert "AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ123456" not in audit_text
    assert "do not log" not in audit_text
    unknown = _sanitized_policy_error(
        core.PolicyError("opaque user-derived validation detail"),
        validation_stage="model_proposal",
        action="unknown",
        task_id="agent-hub-audit-test",
    )
    assert unknown["field"] == "unknown" and unknown["reason"] == "policy_validation_failed"
    assert "opaque user-derived validation detail" not in _audit_instruction(unknown)

    print(json.dumps({
        "coordinator_hardening_v2": "pass",
        "required_root_task_id": 1,
        "verified_evidence_propagation": 1,
        "generic_error_detail": 1,
        "sanitized_policy_error": 1,
        "raw_model_output_logged": 0,
        "low_risk_auto_actions": len(LOW_RISK_AUTO_ACTIONS),
        "count_only_auto_limit_gate": 0,
        "draft_pr_auto_stop": 0,
        "no_progress_repeat_limit": NO_PROGRESS_REPEAT_LIMIT,
    }))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    issue_raw = os.environ.get("HUB_ISSUE_NUMBER", "62").strip()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not token or "/" not in repository or not issue_raw.isdigit() or not api_key:
        raise HardeningError("required coordinator environment is missing")
    github = core.GitHubClient(token, os.environ.get("GITHUB_API_URL", "https://api.github.com"), repository)
    result = process_once(github=github, gemini=core.GeminiClient(api_key), issue_number=int(issue_raw), repository=repository)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"status": "blocked", "error": "hardening_runtime_failed", "error_type": type(exc).__name__, "paid_fallback": 0}), file=os.sys.stderr)
        raise SystemExit(1)
