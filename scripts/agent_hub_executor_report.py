#!/usr/bin/env python3
"""Legacy executor-report adapter.

The v4 coordinator directly validates bot-authored executor reports after a
repository_dispatch. The old adapter is intentionally disabled so it cannot
emit the deprecated short HUB_COMMAND schema.
"""
from __future__ import annotations
import argparse
import json


def run_self_test() -> int:
    print(json.dumps({
        "legacy_executor_report_adapter": "disabled",
        "coordinator": "scripts/agent_hub_free.py",
        "schema": "agent-hub-v4.0",
    }))
    return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        run_self_test()
        return 0
    print("Legacy adapter disabled; the deterministic coordinator handles executor reports.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
