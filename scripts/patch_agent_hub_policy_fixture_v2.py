#!/usr/bin/env python3
"""One-time fixture alignment for the schema-v2 worker registry."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "scripts/agent_hub_policy.py"
SELF = Path(__file__).resolve()


def replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise RuntimeError(f"expected exactly one fixture occurrence: {old}")
    return text.replace(old, new, 1)


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    text = replace_once(text, 'target_worker="prediction-lab",', 'target_worker="integration-planner",')
    text = replace_once(text, 'branch="feature/prediction-lab-standalone",', 'branch="feature/integration-plan",')
    text = replace_once(text, 'allowed_paths=("market-prediction-lab/**",),', 'allowed_paths=("docs/integration-plan.md",),')
    text = replace_once(text, 'json.dumps({"target_worker":"prediction-lab"})', 'json.dumps({"target_worker":"integration-planner"})')
    TARGET.write_text(text, encoding="utf-8")
    for cache in ROOT.rglob("__pycache__"):
        if cache.is_dir():
            shutil.rmtree(cache)
    SELF.unlink()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
