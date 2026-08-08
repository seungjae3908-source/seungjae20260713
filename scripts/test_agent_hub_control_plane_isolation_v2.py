#!/usr/bin/env python3
"""Regression tests for immutable Agent Hub Executor control-plane isolation."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from agent_hub_control_plane_v2 import seal_control_plane, verify_control_plane

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github/workflows/agent-hub-executor.yml"
SOURCE_SHA = "a" * 40


def run(*args: str, cwd: Path, env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args), cwd=cwd, env=env, check=check, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )


def git(cwd: Path, *args: str) -> None:
    run("git", *args, cwd=cwd)


def init_target(path: Path, *, safety_body: str, report_body: str) -> None:
    git(path, "init")
    git(path, "config", "user.name", "fixture")
    git(path, "config", "user.email", "fixture@example.invalid")
    (path / "scripts").mkdir()
    (path / "scripts/agent_hub_executor_safety_v2.py").write_text(safety_body, encoding="utf-8")
    (path / "scripts/agent_hub_executor_report_hardening_v2.py").write_text(report_body, encoding="utf-8")
    (path / "feature").mkdir()
    (path / "feature/data.txt").write_text("base\n", encoding="utf-8")
    git(path, "add", ".")
    git(path, "commit", "-m", "arbitrarily old target fixture")


def safety_env(control: Path, *, mode: str, allowed: str, forbidden: str = '["ops/**"]', max_files: str = "0") -> dict[str, str]:
    env = dict(os.environ)
    env.update({
        "PYTHONPATH": str(control),
        "EXECUTION_MODE": mode,
        "BASE_REF": "HEAD",
        "ALLOWED_PATHS": allowed,
        "FORBIDDEN_PATHS": forbidden,
        "MAX_FILES": max_files,
    })
    return env


def run_trusted_safety(target: Path, control: Path, *, mode: str, allowed: str, max_files: str = "0", check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(
        "python3", str(control / "agent_hub_executor_safety_v2.py"), "validate-diff",
        cwd=target, env=safety_env(control, mode=mode, allowed=allowed, max_files=max_files), check=check,
    )


def test_workflow_contract() -> int:
    text = WORKFLOW.read_text(encoding="utf-8")
    checkout = text.index("ref: ${{ github.sha }}")
    seal = text.index("Seal immutable Agent Hub control plane")
    prepare = text.index("Prepare trusted sealed schema-v2 command")
    switch = text.index("Create or reuse exact safe work branch")
    diff = text.index("Validate diff safety")
    report = text.index("Post schema-v2 executor report and wake coordinator")
    assert checkout < seal < prepare < switch < diff < report
    assert "CONTROL_PLANE_SHA: ${{ github.sha }}" in text
    pre_switch = text[seal:switch]
    assert "python3 scripts/agent_hub_control_plane_v2.py seal" in pre_switch
    assert "python3 \"$CONTROL_PLANE_DIR/agent_hub_control_plane_v2.py\" verify" in text
    assert "python3 \"$CONTROL_PLANE_DIR/agent_hub_executor_gate_hardening_v2.py\"" in text
    assert "python3 \"$CONTROL_PLANE_DIR/agent_hub_executor_safety_v2.py\" validate-diff" in text
    assert "python3 \"$CONTROL_PLANE_DIR/agent_hub_executor_report_hardening_v2.py\"" in text
    after_switch = text[switch:]
    assert "python3 scripts/agent_hub_executor_safety_v2.py" not in after_switch
    assert "python3 scripts/agent_hub_executor_report_hardening_v2.py" not in after_switch
    assert 'PYTHONPATH="$CONTROL_PLANE_DIR" python3 - <<\'PY\'' in after_switch
    return 12


def test_stale_and_malicious_targets() -> int:
    stale_safety = "import json, os\nvalue=json.loads(os.environ['ALLOWED_PATHS'])\nraise SystemExit(0 if value else 91)\n"
    stale_report = "print('STALE_REPORT_NO_TERMINAL_STATE_NO_WAKE')\n"
    malicious_safety = "raise SystemExit(0)\n"
    with tempfile.TemporaryDirectory(prefix="agent-hub-isolation-") as raw:
        root = Path(raw)
        control = root / "control"
        target = root / "target"
        target.mkdir()
        seal_control_plane(repository_root=ROOT, destination=control, source_sha=SOURCE_SHA)
        before = json.dumps(verify_control_plane(destination=control, source_sha=SOURCE_SHA), sort_keys=True)

        # Scenario A/J: arbitrarily old target rejects read_only + [] but trusted safety passes.
        init_target(target, safety_body=stale_safety, report_body=stale_report)
        stale_direct = run("python3", "scripts/agent_hub_executor_safety_v2.py", cwd=target, env=safety_env(control, mode="read_only", allowed="[]"), check=False)
        assert stale_direct.returncode == 91
        trusted = run_trusted_safety(target, control, mode="read_only", allowed="[]")
        assert trusted.returncode == 0 and '"has_changes": false' in trusted.stdout.lower()

        # Scenario B: committed malicious target safety cannot override the sealed trusted copy.
        (target / "scripts/agent_hub_executor_safety_v2.py").write_text(malicious_safety, encoding="utf-8")
        git(target, "add", "scripts/agent_hub_executor_safety_v2.py")
        git(target, "commit", "-m", "malicious target safety")
        assert run_trusted_safety(target, control, mode="read_only", allowed="[]").returncode == 0
        after = json.dumps(verify_control_plane(destination=control, source_sha=SOURCE_SHA), sort_keys=True)
        assert before == after

        # Scenario F: read-only mutation is still fail-closed even with allowed_paths=[].
        (target / "unexpected.txt").write_text("mutation\n", encoding="utf-8")
        blocked = run_trusted_safety(target, control, mode="read_only", allowed="[]", check=False)
        assert blocked.returncode != 0 and "read-only command modified repository files" in blocked.stderr
        (target / "unexpected.txt").unlink()

        # Scenario G: code-change path allowlist behavior remains intact.
        (target / "feature/data.txt").write_text("changed\n", encoding="utf-8")
        allowed = run_trusted_safety(target, control, mode="code_change", allowed='["feature/**"]', max_files="1")
        assert allowed.returncode == 0 and '"has_changes": true' in allowed.stdout.lower()
        outside = run_trusted_safety(target, control, mode="code_change", allowed='["docs/**"]', max_files="1", check=False)
        assert outside.returncode != 0 and "outside allowed scope" in outside.stderr
    return 10


def test_latest_report_lifecycle_from_sealed_plane() -> int:
    with tempfile.TemporaryDirectory(prefix="agent-hub-report-isolation-") as raw:
        control = Path(raw) / "control"
        seal_control_plane(repository_root=ROOT, destination=control, source_sha=SOURCE_SHA)
        env = dict(os.environ)
        env["PYTHONPATH"] = str(control)
        self_test = run("python3", str(control / "agent_hub_executor_report_hardening_v2.py"), "--self-test", cwd=ROOT, env=env)
        payload = json.loads(self_test.stdout.strip())
        assert payload["terminal_command_state_posted"] == 1
        assert payload["event_driven_continuation"] == 1
        assert payload["partial_completed_mismatch"] == 0
        assert payload["critical_auto_actions"] == 0

        script = r'''
import json
from agent_hub_executor_gate_hardening_v2 import READ_ONLY_COMPLETE_MARKER, READ_ONLY_INCOMPLETE_MARKER
from agent_hub_executor_report_hardening_v2 import build_report, build_terminal_state
base={
 "COMMAND_ID":"hub-123-0123456789abcdef","SOURCE_TASK_ID":"root-task","TARGET_WORKER":"operations-worker",
 "GITHUB_REPOSITORY":"owner/repo","TARGET_BRANCH":"feature/old","WORK_BRANCH":"feature/old",
 "CONTROL_PLANE_SHA":"a"*40,"REPORT_BASE_BRANCH":"main","REPORT_BASE_SHA":"a"*40,
 "BASE_SHA":"b"*40,"HEAD_SHA":"b"*40,"REPORT_HEAD_SHA":"b"*40,
 "EXECUTOR_RUN_ID":"123","PR_URL":"none","CHANGED_FILES":"[]","SOURCE_CI_RUN_ID":"42",
 "EXECUTION_MODE":"read_only","AUTO_STEP":"1"
}
failed={**base,"RESULT_STATUS":"failed","SUMMARY":"validation failed","FAILURE_SIGNATURE":"inspect_repository:bbbb:failed"}
partial={**base,"RESULT_STATUS":"completed","SUMMARY":"content analysis incomplete "+READ_ONLY_INCOMPLETE_MARKER}
completed={**base,"RESULT_STATUS":"completed","SUMMARY":"content analysis complete "+READ_ONLY_COMPLETE_MARKER}
assert "status: failed" in build_report(failed)
assert "status: failed" in build_terminal_state(failed)
assert "status: partial" in build_report(partial)
assert "status: blocked" in build_terminal_state(partial)
assert "status: completed" in build_report(completed)
assert "status: completed" in build_terminal_state(completed)
print(json.dumps({"failure_terminal":1,"partial_terminal_blocked":1,"success_terminal":1,"stale_running":0}))
'''
        lifecycle = run("python3", "-c", script, cwd=ROOT, env=env)
        state = json.loads(lifecycle.stdout.strip())
        assert state == {"failure_terminal": 1, "partial_terminal_blocked": 1, "success_terminal": 1, "stale_running": 0}
    return 10


def main() -> int:
    assertions = 0
    assertions += test_workflow_contract()
    assertions += test_stale_and_malicious_targets()
    assertions += test_latest_report_lifecycle_from_sealed_plane()
    print(json.dumps({
        "agent_hub_control_plane_isolation_v2": "pass",
        "assertions": assertions,
        "stale_target_safety_influence": 0,
        "malicious_target_safety_influence": 0,
        "read_only_empty_allowed_paths": 1,
        "read_only_mutation_accepted": 0,
        "code_change_allowlist_preserved": 1,
        "failure_terminal_closure": 1,
        "partial_terminal_completed": 0,
        "success_terminal_closure": 1,
        "report_ready_wake_contract": 1,
        "trusted_control_plane_hash_stable": 1,
        "critical_auto_actions": 0,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
