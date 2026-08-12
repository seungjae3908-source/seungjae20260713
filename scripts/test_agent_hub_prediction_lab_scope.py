#!/usr/bin/env python3
"""Regression checks for Agent Hub Prediction Lab research ownership."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from agent_hub_policy import load_workers, path_allowed, path_forbidden  # noqa: E402


def main() -> int:
    workers = load_workers(ROOT / ".github" / "agent-hub" / "workers.json")
    worker = workers["integration-planner"]

    assert "research/**" in worker.allowed_branches
    assert worker.max_files_per_command == 6
    assert worker.max_commits_per_command == 1
    assert worker.can_modify_code is True
    assert worker.can_run_ci is True
    assert worker.can_create_draft_pr is True

    required_actions = {
        "inspect_repository",
        "inspect_branch",
        "inspect_pull_request",
        "analyze_ci_failure",
        "analyze_logs",
        "run_unit_tests",
        "run_build",
        "report_results",
        "analyze_conflicts",
        "modify_feature_branch",
        "add_or_update_tests",
        "create_draft_pr",
        "update_draft_pr_description",
    }
    assert required_actions.issubset(worker.allowed_action_types)

    allowed = (
        "market-prediction-lab/src/v7-vwap-mean-reversion.js",
        "market-prediction-lab/src/unified-candidate-evaluator.js",
        "market-prediction-lab/tests/market-specialized-alpha-families.test.js",
        "market-prediction-lab/scripts/run-scalping-family-shard.js",
        "market-prediction-lab/README.md",
    )
    for path in allowed:
        assert path_allowed(path, worker), path
        assert not path_forbidden(path, worker.forbidden_path_patterns), path

    blocked = (
        ".github/workflows/prediction-lab-scalping-families.yml",
        ".github/agent-hub/workers.json",
        "scripts/agent_hub_policy.py",
        "production/deploy.sh",
        "api-server/src/routes/user-broker-telegram.ts",
        "stock-analyzer/src/pages/auto-trading.tsx",
        "market-prediction-lab/artifacts/result.json",
        "market-prediction-lab/data/private-history.json",
        "market-prediction-lab/src/live-order-adapter.js",
        "market-prediction-lab/src/private-account-client.js",
    )
    for path in blocked:
        assert (not path_allowed(path, worker)) or path_forbidden(path, worker.forbidden_path_patterns), path

    print(json.dumps({
        "prediction_lab_scope": "pass",
        "worker": worker.worker_id,
        "allowed_samples": len(allowed),
        "blocked_samples": len(blocked),
        "max_files_per_command": worker.max_files_per_command,
        "max_commits_per_command": worker.max_commits_per_command,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
