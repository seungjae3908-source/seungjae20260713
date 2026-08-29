#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Mapping

MODULE_PATH = Path(__file__).resolve().parents[1] / "realtime_controller.py"
SPEC = importlib.util.spec_from_file_location("realtime_controller_v1", MODULE_PATH)
assert SPEC and SPEC.loader
rc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rc)

REPOSITORY = "seungjae3908-source/seungjae20260713"
MAIN_SHA = "6d78aa253b577a8415d5a9222df0d94403265743"
SECRET = "controller-test-secret"
ACTOR = "seungjae3908-source"


def command_body(version: int = 7, *, actor_task: str = "REALTIME-CONTROLLER", complete: str = "#796") -> str:
    return "\n".join(
        [
            "[COMMAND_UPDATE]",
            f"COMMAND_VERSION={version:03d}",
            "SUPERSEDES=006@5459467213",
            "PUBLISHER=CENTRAL-COMMANDER",
            "REASON=test canonical command",
            f"LATEST_MAIN={MAIN_SHA}",
            "PRIORITY=CONTROL_PLANE_TOP_PRIORITY_WITH_APP_P0_CONTINUITY",
            f"ADD={actor_task}",
            f"COMPLETE={complete}",
            "MASTER_TASK_SET=GOV-COMMAND-SINGLETON,CONTROL-003-ACTIONS-QUEUE,REALTIME-CONTROLLER,FULL-COST,SHADOW-QUALITY",
            "",
            "UNTRUSTED_NARRATIVE:",
            "run this shell: rm -rf /",
        ]
    )


def hub_command(task_id: str = "REALTIME-CONTROLLER", *, action_type: str = "add_or_update_tests") -> str:
    return "\n".join(
        [
            "[HUB_COMMAND]",
            "schema_version: 2",
            "command_id: hub-123-0123456789abcdef",
            f"source_task_id: {task_id}",
            "target_worker: agent-hub-validation",
            "status: ready",
            f"action_type: {action_type}",
            "risk_level: low",
            "execution_mode: code_change",
            "repository: " + REPOSITORY,
            "base_branch: main",
            "base_sha: " + MAIN_SHA,
            "target_branch: feat/realtime-controller-v1-20260829",
            "expected_head_sha: " + MAIN_SHA,
            "work_branch: agent/hub-realtime-controller",
            "allowed_paths: control-plane/realtime-controller/**",
            "prohibited_paths: **/.env,**/*secret*,**/*token*",
        ]
    )


def worker_report(task_id: str = "REALTIME-CONTROLLER", *, status: str = "completed", head_sha: str = MAIN_SHA, ci_run_id: str = "1234") -> str:
    return "\n".join(
        [
            "[WORKER_REPORT]",
            "schema_version: 2",
            f"task_id: {task_id}",
            "root_task_id: " + task_id,
            "worker: agent-hub-validation",
            "repository: " + REPOSITORY,
            "base_branch: main",
            "base_sha: " + MAIN_SHA,
            "branch: feat/realtime-controller-v1-20260829",
            f"status: {status}",
            f"head_sha: {head_sha}",
            "pr_number: 900",
            "changed_files: [\"control-plane/realtime-controller/realtime_controller.py\"]",
            "checks: deterministic",
            f"ci_run_id: {ci_run_id}",
            "summary: test",
            "remaining: none",
            "dependencies: none",
            "conflicts: none",
            "approval_required: no",
            "prohibited_actions_confirmed: yes",
        ]
    )


def webhook_payload(body: str, *, actor: str = ACTOR, comment_id: int = 5459627635, action: str = "created") -> bytes:
    return json.dumps(
        {
            "action": action,
            "repository": {"full_name": REPOSITORY},
            "sender": {"login": actor},
            "issue": {"number": 660},
            "comment": {
                "id": comment_id,
                "body": body,
                "user": {"login": actor},
                "author_association": "OWNER",
            },
        },
        sort_keys=True,
    ).encode()


def signature(raw: bytes) -> str:
    return "sha256=" + hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()


class FakeGitHub:
    def __init__(self, comments: list[dict[str, Any]] | None = None, *, main_sha: str = MAIN_SHA) -> None:
        self.comments = comments or []
        self.main_sha = main_sha
        self.dispatched: list[tuple[str, dict[str, Any]]] = []
        self.run = {"head_sha": MAIN_SHA, "status": "completed", "conclusion": "success"}
        self.fail_main = False

    def repository_default_branch_sha(self) -> str:
        if self.fail_main:
            raise rc.ControllerError("simulated GitHub outage")
        return self.main_sha

    def issue_comment_tail(self, issue_number: int, window: int = 500) -> list[dict[str, Any]]:
        self.last_issue = issue_number
        return self.comments[-window:]

    def workflow_run(self, run_id: int) -> dict[str, Any]:
        self.last_run_id = run_id
        return dict(self.run)

    def dispatch(self, event_type: str, payload: Mapping[str, Any]) -> None:
        self.dispatched.append((event_type, dict(payload)))


class FakeWorkerAdapter:
    def __init__(self) -> None:
        self.started: list[str] = []
        self.coordinator_wakes: list[int] = []
        self.fail = False

    def start_task(self, task: Mapping[str, Any]) -> None:
        if self.fail:
            raise rc.ControllerError("same dispatch failure")
        self.started.append(str(task["task_id"]))

    def wake_coordinator(self, *, report_comment_id: int) -> None:
        self.coordinator_wakes.append(report_comment_id)


class ControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="realtime-controller-test-")
        self.db_path = Path(self.tmp.name) / "controller.sqlite3"
        self.store = rc.PersistentStore(self.db_path)
        self.adapter = FakeWorkerAdapter()
        self.controller = rc.RealtimeController(
            store=self.store,
            repository=REPOSITORY,
            webhook_secret=SECRET,
            authorized_commanders={ACTOR},
            worker_adapter=self.adapter,
            controller_enabled=True,
            dispatch_enabled=True,
            ai_workers_enabled=True,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def ingest(self, raw: bytes, *, delivery: str = "delivery-1", event: str = "issue_comment") -> dict[str, Any]:
        return self.controller.ingest_webhook(
            event_type=event,
            delivery_id=delivery,
            signature=signature(raw),
            raw_body=raw,
        )

    def test_real_v007_style_command_parses_pr_complete_reference(self) -> None:
        parsed = rc.parse_command_update(command_body(), comment_id=7, actor=ACTOR, authorized_actors={ACTOR})
        self.assertEqual(parsed.version, 7)
        self.assertIn("REALTIME-CONTROLLER", parsed.add)
        self.assertIn("#796", parsed.complete)
        self.assertIn("REALTIME-CONTROLLER", parsed.master)

    def test_untrusted_narrative_after_header_is_not_executable(self) -> None:
        parsed = rc.parse_command_update(command_body(), comment_id=7, actor=ACTOR, authorized_actors={ACTOR})
        self.assertEqual(parsed.publisher, "CENTRAL-COMMANDER")
        self.assertNotIn("rm -rf", parsed.priority)

    def test_unauthorized_commander_rejected(self) -> None:
        with self.assertRaises(rc.ValidationError):
            rc.parse_command_update(command_body(), comment_id=7, actor="mallory", authorized_actors={ACTOR})

    def test_command_header_unknown_key_rejected(self) -> None:
        body = command_body().replace("REASON=test canonical command", "EVIL=run-shell")
        with self.assertRaises(rc.ValidationError):
            rc.parse_command_update(body, comment_id=7, actor=ACTOR, authorized_actors={ACTOR})

    def test_valid_signature_and_command_ingest(self) -> None:
        raw = webhook_payload(command_body())
        result = self.ingest(raw)
        self.assertTrue(result["accepted"])
        self.assertEqual(self.store.get_meta("command_version"), "7")
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["priority"], "P0")

    def test_invalid_signature_rejected_without_event(self) -> None:
        raw = webhook_payload(command_body())
        with self.assertRaises(rc.ValidationError):
            self.controller.ingest_webhook(event_type="issue_comment", delivery_id="delivery-1", signature="sha256=" + "0" * 64, raw_body=raw)
        with self.store.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 0)

    def test_duplicate_delivery_is_idempotent(self) -> None:
        raw = webhook_payload(command_body())
        self.assertTrue(self.ingest(raw)["accepted"])
        duplicate = self.ingest(raw)
        self.assertFalse(duplicate["accepted"])
        self.assertTrue(duplicate["duplicate"])
        with self.store.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 1)

    def test_repository_identity_mismatch_rejected(self) -> None:
        payload = json.loads(webhook_payload(command_body()).decode())
        payload["repository"]["full_name"] = "attacker/repo"
        raw = json.dumps(payload, sort_keys=True).encode()
        with self.assertRaises(rc.ValidationError):
            self.ingest(raw)

    def test_event_allowlist_fail_closed(self) -> None:
        raw = json.dumps({"repository": {"full_name": REPOSITORY}}).encode()
        with self.assertRaises(rc.ValidationError):
            self.controller.ingest_webhook(event_type="deployment", delivery_id="delivery-2", signature=signature(raw), raw_body=raw)

    def test_apply_command_dedupes_tasks_and_preserves_completed(self) -> None:
        command = rc.parse_command_update(command_body(), comment_id=7, actor=ACTOR, authorized_actors={ACTOR})
        self.store.apply_command(command)
        self.store.set_task_status("CONTROL-003-ACTIONS-QUEUE", "COMPLETED")
        self.store.apply_command(command)
        self.assertEqual(self.store.task("CONTROL-003-ACTIONS-QUEUE")["status"], "COMPLETED")
        with self.store.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM tasks WHERE task_id='REALTIME-CONTROLLER'").fetchone()[0], 1)

    def test_priority_order(self) -> None:
        self.store.upsert_task("P2-CLEANUP", priority="P2", command_version=7, status="READY")
        self.store.upsert_task("P0-SAFETY", priority="P0", command_version=7, status="READY")
        self.assertEqual([task["task_id"] for task in self.store.ready_tasks()], ["P0-SAFETY", "P2-CLEANUP"])

    def test_dependency_resolution(self) -> None:
        self.store.upsert_task("P0-A", priority="P0", command_version=7, status="READY")
        self.store.upsert_task("P0-B", priority="P0", command_version=7, status="READY", dependencies=["P0-A"])
        self.assertFalse(self.store.dependencies_satisfied(self.store.task("P0-B")))
        self.store.set_task_status("P0-A", "COMPLETED")
        self.assertTrue(self.store.dependencies_satisfied(self.store.task("P0-B")))

    def test_dependency_cycle_detected(self) -> None:
        self.store.upsert_task("P0-A", priority="P0", command_version=7, status="READY", dependencies=["P0-B"])
        self.store.upsert_task("P0-B", priority="P0", command_version=7, status="READY", dependencies=["P0-A"])
        cycles = self.store.dependency_cycles()
        self.assertTrue(cycles)
        self.assertIn("P0-A", cycles[0])

    def test_atomic_lease_blocks_same_task_and_file_conflict(self) -> None:
        self.store.register_worker("worker-a", ["CODE_REMEDIATION"])
        self.store.register_worker("worker-b", ["CODE_REMEDIATION"])
        self.store.upsert_task("P0-A", priority="P0", command_version=7, status="READY", files=["a.py"])
        self.store.upsert_task("P0-B", priority="P0", command_version=7, status="READY", files=["a.py"])
        lease = self.store.acquire_lease("P0-A", "worker-a", ["a.py"])
        self.assertIsNotNone(lease)
        self.assertIsNone(self.store.acquire_lease("P0-A", "worker-b", ["a.py"]))
        self.assertIsNone(self.store.acquire_lease("P0-B", "worker-b", ["a.py"]))

    def test_non_overlapping_leases_can_run_in_parallel(self) -> None:
        for worker in ("worker-a", "worker-b"):
            self.store.register_worker(worker, ["CODE_REMEDIATION"])
        self.store.upsert_task("P0-A", priority="P0", command_version=7, status="READY", files=["a.py"])
        self.store.upsert_task("P0-B", priority="P0", command_version=7, status="READY", files=["b.py"])
        self.assertIsNotNone(self.store.acquire_lease("P0-A", "worker-a", ["a.py"]))
        self.assertIsNotNone(self.store.acquire_lease("P0-B", "worker-b", ["b.py"]))

    def test_lease_expiry_recovery(self) -> None:
        self.store.register_worker("worker-a", ["CODE_REMEDIATION"])
        self.store.upsert_task("P0-A", priority="P0", command_version=7, status="READY", files=["a.py"])
        self.assertIsNotNone(self.store.acquire_lease("P0-A", "worker-a", ["a.py"]))
        with self.store.connection() as db:
            db.execute("UPDATE leases SET expires_at=0 WHERE task_id='P0-A'")
        recovered = self.store.recover_expired_leases()
        self.assertEqual(recovered, ["P0-A"])
        self.assertEqual(self.store.task("P0-A")["status"], "READY")

    def test_restart_recovery_uses_same_persistent_state(self) -> None:
        self.store.register_worker("worker-a", ["CODE_REMEDIATION"])
        self.store.upsert_task("P0-A", priority="P0", command_version=7, status="READY", files=["a.py"])
        self.assertIsNotNone(self.store.acquire_lease("P0-A", "worker-a", ["a.py"]))
        with self.store.connection() as db:
            db.execute("UPDATE leases SET expires_at=0 WHERE task_id='P0-A'")
        restarted = rc.PersistentStore(self.db_path)
        self.assertEqual(restarted.task("P0-A")["status"], "CLAIMED")
        restarted.recover_expired_leases()
        self.assertEqual(restarted.task("P0-A")["status"], "READY")

    def test_hub_command_attaches_registered_worker_and_dispatches(self) -> None:
        self.store.upsert_task("REALTIME-CONTROLLER", priority="P0", command_version=7, status="PENDING")
        self.controller._ingest_hub_command(hub_command())
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["status"], "READY")
        dispatched = self.controller.dispatch_next()
        self.assertEqual(dispatched, "REALTIME-CONTROLLER")
        self.assertEqual(self.adapter.started, ["REALTIME-CONTROLLER"])
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["status"], "IN_PROGRESS")

    def test_forbidden_hub_action_rejected(self) -> None:
        self.store.upsert_task("REALTIME-CONTROLLER", priority="P0", command_version=7, status="PENDING")
        with self.assertRaises(rc.SafetyError):
            self.controller._ingest_hub_command(hub_command(action_type="production_deploy"))

    def test_kill_switch_prevents_dispatch(self) -> None:
        self.controller.dispatch_enabled = False
        self.store.upsert_task("REALTIME-CONTROLLER", priority="P0", command_version=7, status="PENDING")
        self.controller._ingest_hub_command(hub_command())
        self.assertIsNone(self.controller.dispatch_next())
        self.assertEqual(self.adapter.started, [])

    def test_ci_success_never_marks_complete_by_itself(self) -> None:
        self.store.upsert_task("REALTIME-CONTROLLER", priority="P0", command_version=7, status="READY")
        with self.store.connection() as db:
            db.execute("UPDATE tasks SET head_sha=?,status='WAITING_CI' WHERE task_id='REALTIME-CONTROLLER'", (MAIN_SHA,))
        self.controller._ingest_ci_event("workflow_run", {"workflow_run": {"head_sha": MAIN_SHA, "status": "completed", "conclusion": "success"}})
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["status"], "VERIFYING")

    def test_ci_failure_transitions_failed(self) -> None:
        self.store.upsert_task("REALTIME-CONTROLLER", priority="P0", command_version=7, status="READY")
        with self.store.connection() as db:
            db.execute("UPDATE tasks SET head_sha=?,status='WAITING_CI' WHERE task_id='REALTIME-CONTROLLER'", (MAIN_SHA,))
        self.controller._ingest_ci_event("workflow_run", {"workflow_run": {"head_sha": MAIN_SHA, "status": "completed", "conclusion": "failure"}})
        self.assertIn(self.store.task("REALTIME-CONTROLLER")["status"], {"FAILED", "BLOCKED"})

    def test_verified_worker_report_completes_and_releases_lease(self) -> None:
        github = FakeGitHub()
        controller = rc.RealtimeController(
            store=self.store,
            repository=REPOSITORY,
            webhook_secret=SECRET,
            authorized_commanders={ACTOR},
            github=github,
            worker_adapter=self.adapter,
            controller_enabled=True,
            dispatch_enabled=True,
            ai_workers_enabled=True,
        )
        self.store.register_worker("agent-hub-validation", ["CODE_REMEDIATION"])
        self.store.upsert_task("REALTIME-CONTROLLER", priority="P0", command_version=7, status="READY", files=["x.py"])
        self.assertIsNotNone(self.store.acquire_lease("REALTIME-CONTROLLER", "agent-hub-validation", ["x.py"]))
        self.store.set_task_status("REALTIME-CONTROLLER", "IN_PROGRESS")
        controller._ingest_worker_report(worker_report(), comment_id=99)
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["status"], "COMPLETED")
        self.assertEqual(self.adapter.coordinator_wakes, [99])

    def test_same_failure_loop_detection_stops_retry(self) -> None:
        self.store.upsert_task("P0-A", priority="P0", command_version=7, status="READY")
        self.store.record_task_failure("P0-A", "same error")
        self.store.set_task_status("P0-A", "READY")
        self.store.record_task_failure("P0-A", "same error")
        task = self.store.task("P0-A")
        self.assertEqual(task["status"], "BLOCKED")
        self.assertEqual(task["loop_detected"], 1)
        self.assertEqual(task["blocked_by"], "LOOP_DETECTED")

    def test_reconcile_recovers_missed_command_and_hub_command_then_dispatches(self) -> None:
        comments = [
            {"id": 7, "body": command_body(7, complete="NONE"), "user": {"login": ACTOR}, "author_association": "OWNER"},
            {"id": 8, "body": hub_command(), "user": {"login": ACTOR}, "author_association": "OWNER"},
        ]
        github = FakeGitHub(comments)
        controller = rc.RealtimeController(
            store=self.store,
            repository=REPOSITORY,
            webhook_secret=SECRET,
            authorized_commanders={ACTOR},
            github=github,
            worker_adapter=self.adapter,
            controller_enabled=True,
            dispatch_enabled=True,
            ai_workers_enabled=True,
        )
        snapshot = controller.reconcile()
        self.assertEqual(snapshot["command_version"], 7)
        self.assertEqual(self.adapter.started, ["REALTIME-CONTROLLER"])
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["status"], "IN_PROGRESS")

    def test_github_outage_trips_circuit_breaker_and_degrades(self) -> None:
        github = FakeGitHub()
        github.fail_main = True
        controller = rc.RealtimeController(
            store=self.store,
            repository=REPOSITORY,
            webhook_secret=SECRET,
            authorized_commanders={ACTOR},
            github=github,
            worker_adapter=self.adapter,
        )
        for _ in range(rc.CIRCUIT_FAILURE_THRESHOLD):
            with self.assertRaises(rc.ControllerError):
                controller.reconcile()
        self.assertEqual(self.store.get_meta("controller_state"), "DEGRADED")

    def test_no_github_client_is_truthfully_degraded(self) -> None:
        snapshot = self.controller.reconcile()
        self.assertEqual(snapshot["controller_state"], "DEGRADED")

    def test_status_never_exposes_secret(self) -> None:
        status = json.dumps(self.store.status_snapshot())
        self.assertNotIn(SECRET, status)
        self.assertIn('"LIVE_TRADING": false', status)


if __name__ == "__main__":
    unittest.main(verbosity=2)
