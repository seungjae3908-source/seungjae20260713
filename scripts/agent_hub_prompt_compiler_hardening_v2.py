#!/usr/bin/env python3
"""State/delta preserving adapter around the existing PR #70 Prompt Compiler."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

import agent_hub_prompt_compiler_v2 as base
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
            fields=fields,
            sanitized_report=sanitized_report,
            allowed_action_types=allowed_action_types,
            registered_workers=registered_workers,
            policy_version=policy_version,
            maximum_context_size=maximum_context_size,
        )
    finally:
        base.PROFILE_ALLOWED_ACTIONS[profile] = original


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
    except json.JSONDecodeError as exc:
        raise PromptHardeningError("base GOAL block is invalid JSON") from exc
    if not isinstance(goal, dict):
        raise PromptHardeningError("base GOAL block is not an object")
    goal.update(
        {
            "state_delta": delta,
            "compact_state_only": True,
        }
    )
    blocks["GOAL"] = json.dumps(goal, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
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
    return base.decisions_agree(first, second)


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
    assert all(changed.prompt.count(f"[{name}]") == 1 for name in base.BLOCK_NAMES)
    assert '"state_delta"' in changed.prompt
    assert '"previous_state"' not in changed.prompt and '"current_state"' not in changed.prompt
    assert changed.previous_state == first.current_state and changed.current_state.head_sha == "c"*40
    assert base.PROFILE_ALLOWED_ACTIONS[base.infer_profile(fields)] == ("inspect_repository", "inspect_branch", "inspect_pull_request", "analyze_conflicts", "create_integration_plan", "report_results")
    print(json.dumps({
        "prompt_state_hardening_v2":"pass",
        "blocks":5,
        "delta_only_prompt":True,
        "empty_delta":True,
        "changed_delta":sorted(changed.state_delta),
        "safe_continuation_actions":len(SAFE_CONTINUATION_ACTIONS),
        "base_profile_restored":True,
    }))
    return 0

if __name__ == "__main__":
    raise SystemExit(self_test())
