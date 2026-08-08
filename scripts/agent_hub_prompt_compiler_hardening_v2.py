#!/usr/bin/env python3
"""State/delta preserving adapter around the existing PR #70 Prompt Compiler."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

import agent_hub_prompt_compiler_v2 as base
from agent_hub_contract_v2 import PATHLESS_READ_ONLY_ACTIONS
from agent_hub_state_v2 import CompactState, build_current_state, latest_matching_state, state_delta

BLOCK_RE = re.compile(
    r"\[(ROLE|GOAL|EVIDENCE|CONSTRAINTS|OUTPUT_SCHEMA)\]\n(.*?)(?=\n\n\[(?:ROLE|GOAL|EVIDENCE|CONSTRAINTS|OUTPUT_SCHEMA)\]\n|\Z)",
    re.DOTALL,
)
SAFE_CONTINUATION_ACTIONS = (
    "inspect_repository", "inspect_branch", "inspect_pull_request", "analyze_ci_failure", "analyze_logs",
    "analyze_playwright_trace", "run_typecheck", "run_unit_tests", "run_build", "run_playwright",
    "create_draft_pr", "update_draft_pr_description", "report_results", "analyze_conflicts",
    "create_integration_plan", "inspect_security_contract", "inspect_private_api_calls",
    "inspect_paper_vs_live_order_separation",
)


class PromptHardeningError(RuntimeError):
    pass


@dataclass(frozen=True)
class HardenedCompiledPrompt:
    base: base.CompiledPrompt
    prompt: str
    previous_state: CompactState | None
    current_state: CompactState
    state_delta: dict[str, dict[str, Any]]

    def __getattr__(self, name: str) -> Any:
        return getattr(self.base, name)


def _blocks(prompt: str) -> dict[str, str]:
    blocks = {name: value for name, value in BLOCK_RE.findall(prompt)}
    if tuple(blocks) != base.BLOCK_NAMES:
        raise PromptHardeningError("base prompt did not contain exactly the five required blocks")
    return blocks


def _compiler_fields(fields: Mapping[str, Any]) -> dict[str, Any]:
    """Preserve an explicit empty changed_files fact as prompt-only evidence.

    Schema-v2 distinguishes a missing changed_files field from a present empty list.
    The base compiler emits changed_files evidence only for non-empty paths, so an
    explicit clean-branch fact would otherwise be misclassified as missing evidence.
    Compact state and policy evaluation continue to receive the original empty list.
    """
    prepared = dict(fields)
    if "changed_files" not in fields:
        return prepared
    value = fields.get("changed_files")
    if isinstance(value, (list, tuple, set)):
        empty = not any(str(item).strip() for item in value)
    else:
        text = str(value or "").strip().lower()
        empty = text in {"", "none", "[]"}
    if empty:
        prepared["changed_files"] = ["(none reported; explicit empty list)"]
    return prepared


def _compile_with_safe_continuations(
    *,
    fields: Mapping[str, Any],
    sanitized_report: str,
    allowed_action_types: Iterable[str],
    registered_workers: Iterable[str],
    policy_version: str,
    maximum_context_size: int,
) -> base.CompiledPrompt:
    """Expose existing low-risk policy actions to the model without granting authority.

    The model still cannot authorize anything. The deterministic policy/worker registry
    remains the final gate, so actions unsupported by a worker are rejected after proposal.
    """
    profile = base.infer_profile(fields)
    original = base.PROFILE_ALLOWED_ACTIONS[profile]
    augmented = tuple(dict.fromkeys((*original, *SAFE_CONTINUATION_ACTIONS)))
    base.PROFILE_ALLOWED_ACTIONS[profile] = augmented
    try:
        return base.compile_prompt(
            fields=_compiler_fields(fields),
            sanitized_report=sanitized_report,
            allowed_action_types=allowed_action_types,
            registered_workers=registered_workers,
            policy_version=policy_version,
            maximum_context_size=maximum_context_size,
        )
    finally:
        base.PROFILE_ALLOWED_ACTIONS[profile] = original


def _canonical_model_proposal(value: Mapping[str, Any]) -> dict[str, Any]:
    canonical = dict(value)
    if canonical.get("action_type") in PATHLESS_READ_ONLY_ACTIONS:
        canonical["allowed_paths"] = []
    return canonical


def compile_prompt(
    *,
    fields: Mapping[str, Any],
    sanitized_report: str,
    allowed_action_types: Iterable[str],
    registered_workers: Iterable[str],
    policy_version: str,
    comments: Sequence[Mapping[str, Any]] = (),
    updated_at: str = "",
    maximum_context_size: int = 16000,
) -> HardenedCompiledPrompt:
    compiled = _compile_with_safe_continuations(
        fields=fields,
        sanitized_report=sanitized_report,
        allowed_action_types=allowed_action_types,
        registered_workers=registered_workers,
        policy_version=policy_version,
        maximum_context_size=maximum_context_size,
    )
    current = build_current_state(fields, updated_at=updated_at)
    previous = latest_matching_state(
        comments,
        repository=current.repository,
        worker=current.worker,
        branch=current.branch,
    )
    delta = state_delta(previous, current)
    blocks = _blocks(compiled.prompt)
    try:
        goal = json.loads(blocks["GOAL"])
        constraints = json.loads(blocks["CONSTRAINTS"])
    except json.JSONDecodeError as exc:
        raise PromptHardeningError("base prompt block is invalid JSON") from exc
    if not isinstance(goal, dict) or not isinstance(constraints, dict):
        raise PromptHardeningError("base GOAL/CONSTRAINTS block is not an object")
    goal.update(
        {
            "state_delta": delta,
            "compact_state_only": True,
        }
    )
    pathless_actions = sorted(set(compiled.allowed_action_types).intersection(PATHLESS_READ_ONLY_ACTIONS))
    rules = constraints.get("rules")
    if not isinstance(rules, list) or any(not isinstance(item, str) for item in rules):
        raise PromptHardeningError("base CONSTRAINTS rules are invalid")
    rules.extend(
        [
            "For action_type in pathless_read_only_actions, allowed_paths MUST be [].",
            "For pathless read-only actions, do not invent src/, tests/, repository root, glob, or any other file path.",
            "Code-change actions must keep explicit non-empty allowed_paths; never use the pathless rule for code changes.",
        ]
    )
    constraints["pathless_read_only_actions"] = pathless_actions
    constraints["rules"] = rules
    blocks["GOAL"] = json.dumps(goal, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    blocks["CONSTRAINTS"] = json.dumps(constraints, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    prompt = "\n\n".join(f"[{name}]\n{blocks[name]}" for name in base.BLOCK_NAMES)
    if len(prompt) > compiled.maximum_context_size:
        raise PromptHardeningError("state-aware prompt exceeds profile context limit")
    return HardenedCompiledPrompt(
        base=compiled,
        prompt=prompt,
        previous_state=previous,
        current_state=current,
        state_delta=delta,
    )


def parse_model_proposal(raw: str, compiled: HardenedCompiledPrompt) -> dict[str, Any]:
    return base.parse_model_proposal(raw, compiled.base)


def decisions_agree(first: Mapping[str, Any], second: Mapping[str, Any]) -> bool:
    return base.decisions_agree(_canonical_model_proposal(first), _canonical_model_proposal(second))


def self_test() -> int:
    fields = {
        "task_id":"state-demo", "worker":"integration-planner", "repository":"owner/repo",
        "base_sha":"a"*40, "branch":"feature/demo", "head_sha":"b"*40,
        "pr_number":"70", "changed_files":["docs/demo.md"], "checks":"success",
        "ci_run_id":"123", "status":"partial", "summary":"partial", "remaining":"inspect",
    }
    first = compile_prompt(fields=fields, sanitized_report="success", allowed_action_types=("analyze_conflicts", "run_build", "create_draft_pr"), registered_workers=("integration-planner",), policy_version="v4")
    assert first.previous_state is None and "initial" in first.state_delta
    assert "run_build" in first.allowed_action_types and "create_draft_pr" in first.allowed_action_types
    from agent_hub_state_v2 import format_state_snapshot
    comments = [{"body": format_state_snapshot(first.current_state)}]
    same = compile_prompt(fields=fields, sanitized_report="success", allowed_action_types=("analyze_conflicts",), registered_workers=("integration-planner",), policy_version="v4", comments=comments)
    assert same.previous_state == first.current_state and same.state_delta == {}
    changed = compile_prompt(fields={**fields,"head_sha":"c"*40,"status":"completed"}, sanitized_report="success", allowed_action_types=("analyze_conflicts",), registered_workers=("integration-planner",), policy_version="v4", comments=comments)
    assert set(changed.state_delta) == {"head_sha","status"}

    empty_files = compile_prompt(
        fields={
            **fields,
            "worker":"market-information-room",
            "pr_number":"none",
            "changed_files":[],
        },
        sanitized_report="success",
        allowed_action_types=("inspect_repository",),
        registered_workers=("market-information-room",),
        policy_version="v4",
    )
    assert "changed_files" not in empty_files.missing_required
    assert empty_files.current_state.changed_files == ()
    assert any(
        item.category == "changed_files" and "explicit empty list" in item.content
        for item in empty_files.evidence
    )
    missing_files = compile_prompt(
        fields={
            **{key: value for key, value in fields.items() if key != "changed_files"},
            "worker":"market-information-room",
            "pr_number":"none",
        },
        sanitized_report="success",
        allowed_action_types=("inspect_repository",),
        registered_workers=("market-information-room",),
        policy_version="v4",
    )
    assert "changed_files" in missing_files.missing_required

    assert all(changed.prompt.count(f"[{name}]") == 1 for name in base.BLOCK_NAMES)
    assert '"state_delta"' in changed.prompt
    assert '"previous_state"' not in changed.prompt and '"current_state"' not in changed.prompt
    assert changed.previous_state == first.current_state and changed.current_state.head_sha == "c"*40
    assert base.PROFILE_ALLOWED_ACTIONS[base.infer_profile(fields)] == ("inspect_repository", "inspect_branch", "inspect_pull_request", "analyze_conflicts", "create_integration_plan", "report_results")

    release_fields = {
        "task_id":"pathless-demo", "worker":"operations-worker", "repository":"owner/repo",
        "base_sha":"a"*40, "branch":"agent/hub-e2e-fixture-20260806", "head_sha":"b"*40,
        "pr_number":"none", "changed_files":[], "checks":"fixture CI success",
        "ci_run_id":"31079503537", "status":"partial", "summary":"read-only seed", "remaining":"inspect repository",
    }
    release = compile_prompt(
        fields=release_fields,
        sanitized_report="fixture CI success",
        allowed_action_types=("inspect_repository",),
        registered_workers=("operations-worker",),
        policy_version="v4",
    )
    release_constraints = json.loads(_blocks(release.prompt)["CONSTRAINTS"])
    assert release.profile == "release_validator" and not release.missing_required
    assert release_constraints["pathless_read_only_actions"] == ["inspect_repository"]
    assert any("allowed_paths MUST be []" in rule for rule in release_constraints["rules"])
    assert any("do not invent src/" in rule for rule in release_constraints["rules"])
    pathless_a = {"action_type":"inspect_repository", "allowed_paths":["src/","tests/"]}
    pathless_b = {"action_type":"inspect_repository", "allowed_paths":[]}
    assert decisions_agree(pathless_a, pathless_b)
    change_a = {"action_type":"modify_feature_branch", "allowed_paths":["src/a.ts"]}
    change_b = {"action_type":"modify_feature_branch", "allowed_paths":[]}
    assert not decisions_agree(change_a, change_b)

    print(json.dumps({
        "prompt_state_hardening_v2":"pass",
        "blocks":5,
        "delta_only_prompt":True,
        "empty_delta":True,
        "changed_delta":sorted(changed.state_delta),
        "safe_continuation_actions":len(SAFE_CONTINUATION_ACTIONS),
        "base_profile_restored":True,
        "explicit_empty_changed_files":True,
        "missing_changed_files_rejected":True,
        "pathless_prompt_contract":1,
        "pathless_model_variance_normalized":1,
        "code_change_path_variance_normalized":0,
    }))
    return 0

if __name__ == "__main__":
    raise SystemExit(self_test())
