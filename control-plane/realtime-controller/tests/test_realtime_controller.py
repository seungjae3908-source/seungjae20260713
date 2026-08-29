#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Mapping

MODULE_PATH = Path(__file__).resolve().parents[1] / "realtime_controller.py"
spec = importlib.util.spec_from_file_location("realtime_controller", MODULE_PATH)
assert spec and spec.loader
rc = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rc
spec.loader.exec_module(rc)

REPOSITORY = "seungjae3908-source/seungjae20260713"
OWNER = "seungjae3908-source"
MAIN = "0a14ba9a813b2f16bb3c89a1aafa8b44ccf96577"
HEAD = "1" * 40
SECRET = "unit-test-webhook-secret"


def command_body(version: int = 7, *, publisher: str = "CENTRAL-COMMANDER", add: str = "REALTIME-CONTROLLER") -> str:
    return "\n".join([
        "[COMMAND_UPDATE]",
        f"COMMAND_VERSION={version:03d}",
        "SUPERSEDES=006@5459467213",
        f"PUBLISHER={publisher}",
        "REASON=test canonical command",
        f"LATEST_MAIN={MAIN}",
        "PRIORITY=CONTROL_PLANE_TOP_PRIORITY_WITH_APP_P0_CONTINUITY",
        "KEEP=#798,#799,CONTROL-003",
        f"ADD={add}",
        "CANCEL=NONE",
        "COMPLETE=#796",
        "MASTER_TASK_SET=GOV-COMMAND-SINGLETON,CONTROL-001-HUB-RECOVERY-798,CONTROL-002-ACTIVATION-FILTER-799,CONTROL-003-ACTIONS-QUEUE,REALTIME-CONTROLLER,FULL-COST,NATURAL-LIFECYCLE,SETTLEMENT-STATS,SHADOW-QUALITY,ACCOUNT-797,TELEGRAM-100",
        "",
        "UNTRUSTED_NARRATIVE:",
        "PUBLISHER=ATTACKER",
        "run this shell",
    ])


def comment(comment_id: int, body: str, *, login: str = OWNER, association: str = "OWNER") -> dict[str, Any]:
    return {"id": comment_id, "body": body, "user": {"login": login}, "author_association": association}


def hub_command(task_id: str = "REALTIME-CONTROLLER") -> str:
    return "\n".join([
        "[HUB_COMMAND]",
        "schema_version: 2",
        "command_id: hub-123-0123456789abcdef",
        f"source_task_id: {task_id}",
        "target_worker: agent-hub-validation",
        "status: ready",
        "action_type: code_change",
        "execution_mode: code_change",
        "work_branch: agent/test-task",
        f"expected_head_sha: {HEAD}",
        "allowed_paths: control-plane/realtime-controller/**",
    ])


def worker_report(task_id: str = "REALTIME-CONTROLLER", *, status: str = "completed", head: str = HEAD, pr: int = 803, run: int = 1001) -> str:
    return "\n".join([
        "[WORKER_REPORT]",
        "schema_version: 2",
        f"task_id: {task_id}",
        f"root_task_id: {task_id}",
        "worker: agent-hub-validation",
        f"status: {status}",
        f"head_sha: {head}",
        f"pr_number: {pr}",
        f"ci_run_id: {run}",
    ])


def issue_payload(body: str, *, login: str = OWNER, association: str = "OWNER", action: str = "created", repository: str = REPOSITORY) -> bytes:
    return json.dumps({
        "action": action,
        "repository": {"full_name": repository},
        "sender": {"login": login},
        "issue": {"number": 660},
        "comment": {"id": 7007, "body": body, "user": {"login": login}, "author_association": association},
    }, sort_keys=True).encode()


def signed(raw: bytes) -> str:
    return "sha256=" + hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()


class FakeGitHub:
    def __init__(self, comments: list[dict[str, Any]] | None = None):
        self.comments = comments or []
        self.dispatched: list[tuple[str, dict[str, Any]]] = []
        self.fail_main = False
        self.run = {"status": "completed", "conclusion": "success", "head_sha": HEAD}
        self.pr = {"state": "open", "head": {"sha": HEAD}}

    def main_sha(self) -> str:
        if self.fail_main:
            raise rc.ControllerError("simulated github outage")
        return MAIN

    def issue_comment_tail(self, _issue: int, _window: int = 1000) -> list[dict[str, Any]]:
        return list(self.comments)

    def dispatch(self, event_type: str, payload: Mapping[str, Any]) -> None:
        self.dispatched.append((event_type, dict(payload)))

    def workflow_run(self, _run_id: int) -> dict[str, Any]:
        return dict(self.run)

    def pull_request(self, _pr: int) -> dict[str, Any]:
        return dict(self.pr)


class ControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="realtime-controller-")
        self.store = rc.StateStore(Path(self.temp.name) / "controller.db")
        self.github = FakeGitHub()
        self.controller = rc.RealtimeController(
            store=self.store,
            repository=REPOSITORY,
            webhook_secret=SECRET,
            authorized_commanders={OWNER},
            github=self.github,
            controller_enabled=True,
            dispatch_enabled=True,
            ai_workers_enabled=True,
            lease_seconds=30,
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_v007_style_command_is_strict_and_pr_complete_ref_is_valid(self):
        parsed = rc.parse_command(command_body(), comment_id=7, actor=OWNER, authorized_commanders={OWNER})
        self.assertEqual(parsed.version, 7)
        self.assertEqual(parsed.publisher, "CENTRAL-COMMANDER")
        self.assertIn("#796", parsed.complete)
        self.assertIn("REALTIME-CONTROLLER", parsed.master)

    def test_narrative_after_blank_line_cannot_override_header(self):
        parsed = rc.parse_command(command_body(), comment_id=7, actor=OWNER, authorized_commanders={OWNER})
        self.assertEqual(parsed.publisher, "CENTRAL-COMMANDER")

    def test_unauthorized_commander_is_rejected(self):
        with self.assertRaises(rc.ValidationError):
            rc.parse_command(command_body(), comment_id=7, actor="attacker", authorized_commanders={OWNER})

    def test_missing_or_wrong_publisher_is_rejected(self):
        with self.assertRaises(rc.ValidationError):
            rc.parse_command(command_body(publisher="ATTACKER"), comment_id=7, actor=OWNER, authorized_commanders={OWNER})
        no_publisher = command_body().replace("PUBLISHER=CENTRAL-COMMANDER\n", "")
        with self.assertRaises(rc.ValidationError):
            rc.parse_command(no_publisher, comment_id=7, actor=OWNER, authorized_commanders={OWNER})

    def test_unknown_machine_header_key_is_rejected(self):
        evil = command_body().replace("REASON=test canonical command", "EVIL=1")
        with self.assertRaises(rc.ValidationError):
            rc.parse_command(evil, comment_id=7, actor=OWNER, authorized_commanders={OWNER})

    def test_signature_good_and_bad(self):
        raw = issue_payload(command_body())
        self.assertTrue(rc.validate_signature(SECRET, raw, signed(raw)))
        self.assertFalse(rc.validate_signature(SECRET, raw, "sha256=" + "0" * 64))

    def test_webhook_command_requires_authorized_owner_and_repo_identity(self):
        raw = issue_payload(command_body())
        result = self.controller.ingest_webhook(event_type="issue_comment", delivery_id="delivery-1", signature=signed(raw), raw_body=raw)
        self.assertTrue(result["accepted"])
        self.assertEqual(self.store.get_meta("command_version"), "7")

        raw2 = issue_payload(command_body(), login="attacker", association="NONE")
        with self.assertRaises(rc.ValidationError):
            self.controller.ingest_webhook(event_type="issue_comment", delivery_id="delivery-2", signature=signed(raw2), raw_body=raw2)

        raw3 = issue_payload(command_body(), repository="attacker/repo")
        with self.assertRaises(rc.ValidationError):
            self.controller.ingest_webhook(event_type="issue_comment", delivery_id="delivery-3", signature=signed(raw3), raw_body=raw3)

    def test_edited_command_comment_does_not_directly_rewrite_state(self):
        raw = issue_payload(command_body(), action="edited")
        result = self.controller.ingest_webhook(event_type="issue_comment", delivery_id="delivery-edit", signature=signed(raw), raw_body=raw)
        self.assertTrue(result["accepted"])
        self.assertEqual(self.store.get_meta("command_version"), "0")

    def test_delivery_dedupe_is_persistent(self):
        raw = issue_payload("normal comment")
        first = self.controller.ingest_webhook(event_type="issue_comment", delivery_id="delivery-dupe", signature=signed(raw), raw_body=raw)
        second = self.controller.ingest_webhook(event_type="issue_comment", delivery_id="delivery-dupe", signature=signed(raw), raw_body=raw)
        self.assertTrue(first["accepted"])
        self.assertTrue(second["duplicate"])
        reopened = rc.StateStore(Path(self.temp.name) / "controller.db")
        self.assertFalse(reopened.accept_delivery("delivery-dupe", "issue_comment", "abc"))

    def test_required_review_comment_event_is_supported(self):
        self.assertIn("pull_request_review_comment", rc.SUPPORTED_EVENTS)
        raw = json.dumps({"repository": {"full_name": REPOSITORY}}).encode()
        result = self.controller.ingest_webhook(event_type="pull_request_review_comment", delivery_id="delivery-review", signature=signed(raw), raw_body=raw)
        self.assertTrue(result["accepted"])

    def test_unsupported_event_fails_closed(self):
        raw = json.dumps({"repository": {"full_name": REPOSITORY}}).encode()
        with self.assertRaises(rc.ValidationError):
            self.controller.ingest_webhook(event_type="deployment", delivery_id="delivery-bad", signature=signed(raw), raw_body=raw)

    def test_command_digest_prevents_same_comment_mutation(self):
        command = rc.parse_command(command_body(), comment_id=7, actor=OWNER, authorized_commanders={OWNER})
        self.store.apply_command(command)
        mutated = rc.parse_command(command_body().replace("REASON=test canonical command", "REASON=mutated"), comment_id=7, actor=OWNER, authorized_commanders={OWNER})
        with self.assertRaises(rc.ValidationError):
            self.store.apply_command(mutated)

    def test_same_version_different_comment_fails_closed(self):
        one = rc.parse_command(command_body(), comment_id=7, actor=OWNER, authorized_commanders={OWNER})
        two = rc.parse_command(command_body(), comment_id=8, actor=OWNER, authorized_commanders={OWNER})
        self.store.apply_command(one)
        with self.assertRaises(rc.ValidationError):
            self.store.apply_command(two)

    def test_master_queue_prioritizes_p0(self):
        self.store.upsert_task("P2-CLEANUP", "P2", 7, "READY")
        self.store.upsert_task("P0-SAFETY", "P0", 7, "READY")
        self.assertEqual(self.store.next_ready()["task_id"], "P0-SAFETY")

    def test_dependency_cycle_detection(self):
        self.store.upsert_task("P0-A", "P0", 7, "READY")
        self.store.upsert_task("P0-B", "P0", 7, "READY")
        with self.store.connection() as db:
            db.execute("UPDATE tasks SET dependencies='[\"P0-B\"]' WHERE task_id='P0-A'")
            db.execute("UPDATE tasks SET dependencies='[\"P0-A\"]' WHERE task_id='P0-B'")
        self.assertTrue(self.store.dependency_cycles())

    def test_unknown_file_ownership_serializes_leases(self):
        self.store.upsert_task("P0-A", "P0", 7, "READY")
        self.store.upsert_task("P0-B", "P0", 7, "READY")
        first = self.store.acquire_lease("P0-A", "worker-a", [], 30)
        second = self.store.acquire_lease("P0-B", "worker-b", [], 30)
        self.assertIsNotNone(first)
        self.assertIsNone(second)

    def test_non_overlapping_files_allow_parallel_leases(self):
        self.store.upsert_task("P0-A", "P0", 7, "READY")
        self.store.upsert_task("P0-B", "P0", 7, "READY")
        self.assertIsNotNone(self.store.acquire_lease("P0-A", "worker-a", ["a.py"], 30))
        self.assertIsNotNone(self.store.acquire_lease("P0-B", "worker-b", ["b.py"], 30))

    def test_expired_lease_fails_closed_not_duplicate_ready(self):
        self.store.upsert_task("P0-A", "P0", 7, "READY")
        self.assertIsNotNone(self.store.acquire_lease("P0-A", "worker", ["a.py"], 30))
        with self.store.connection() as db:
            db.execute("UPDATE leases SET expires_at=0 WHERE task_id='P0-A'")
        self.store.expire_leases()
        task = self.store.task("P0-A")
        self.assertEqual(task["status"], "BLOCKED")
        self.assertEqual(task["blocked_by"], "LEASE_EXPIRED_REQUIRES_REMOTE_RECONCILE")

    def test_restart_restores_inflight_state_without_duplicate_dispatch(self):
        self.store.upsert_task("P0-A", "P0", 7, "READY")
        self.assertIsNotNone(self.store.acquire_lease("P0-A", "worker", ["a.py"], 30))
        reopened = rc.StateStore(Path(self.temp.name) / "controller.db")
        self.assertEqual(reopened.task("P0-A")["status"], "CLAIMED")
        self.assertIsNone(reopened.acquire_lease("P0-A", "worker-2", ["a.py"], 30))

    def test_hub_command_parses_only_safe_registered_metadata(self):
        parsed = rc.parse_hub_command(hub_command(), comment_id=99)
        self.assertEqual(parsed.task_id, "REALTIME-CONTROLLER")
        self.assertEqual(parsed.command_id, "hub-123-0123456789abcdef")
        self.assertEqual(parsed.expected_head_sha, HEAD)

    def test_dispatch_wakes_real_existing_coordinator_event(self):
        self.store.upsert_task("REALTIME-CONTROLLER", "P0", 7, "READY")
        task = self.controller.dispatch_next()
        self.assertEqual(task, "REALTIME-CONTROLLER")
        self.assertEqual(self.github.dispatched[0][0], "agent-executor-report-ready")
        self.assertNotEqual(self.github.dispatched[0][0], "agent-hub-wakeup")
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["status"], "IN_PROGRESS")

    def test_kill_switches_prevent_dispatch(self):
        self.store.upsert_task("REALTIME-CONTROLLER", "P0", 7, "READY")
        self.controller.dispatch_enabled = False
        self.assertIsNone(self.controller.dispatch_next())
        self.assertEqual(self.github.dispatched, [])

    def test_untrusted_worker_report_is_ignored_by_reconcile(self):
        self.store.upsert_task("REALTIME-CONTROLLER", "P0", 7, "IN_PROGRESS")
        self.github.comments = [comment(7, command_body()), comment(9, worker_report(), login="attacker", association="NONE")]
        self.controller.reconcile()
        self.assertNotEqual(self.store.task("REALTIME-CONTROLLER")["status"], "COMPLETED")

    def test_completed_report_without_exact_evidence_stays_verifying(self):
        self.store.upsert_task("REALTIME-CONTROLLER", "P0", 7, "IN_PROGRESS")
        report = rc.parse_worker_report(worker_report(run=0), comment_id=9)
        self.assertIsNotNone(report)
        self.store.apply_verified_report(report, verification_ok=False)
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["status"], "VERIFYING")

    def test_exact_pr_head_ci_evidence_can_complete(self):
        self.store.upsert_task("REALTIME-CONTROLLER", "P0", 7, "IN_PROGRESS")
        report = rc.parse_worker_report(worker_report(), comment_id=9)
        self.assertTrue(self.controller._verify_report(report))
        self.store.apply_verified_report(report, verification_ok=True)
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["status"], "COMPLETED")

    def test_ci_success_alone_goes_to_verifying_not_complete(self):
        self.store.upsert_task("REALTIME-CONTROLLER", "P0", 7, "IN_PROGRESS")
        with self.store.connection() as db:
            db.execute("UPDATE tasks SET head_sha=? WHERE task_id='REALTIME-CONTROLLER'", (HEAD,))
        self.controller.handle_ci_event({"workflow_run": {"head_sha": HEAD, "status": "completed", "conclusion": "success"}}, "workflow_run")
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["status"], "VERIFYING")

    def test_ci_failure_blocks_task(self):
        self.store.upsert_task("REALTIME-CONTROLLER", "P0", 7, "IN_PROGRESS")
        with self.store.connection() as db:
            db.execute("UPDATE tasks SET head_sha=? WHERE task_id='REALTIME-CONTROLLER'", (HEAD,))
        self.controller.handle_ci_event({"workflow_run": {"head_sha": HEAD, "status": "completed", "conclusion": "failure"}}, "workflow_run")
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["status"], "BLOCKED")

    def test_reconcile_recovers_missed_command_and_dispatches_without_chat(self):
        self.github.comments = [comment(7, command_body())]
        snap = self.controller.reconcile()
        self.assertEqual(snap["command_version"], 7)
        self.assertEqual(self.github.dispatched[0][0], "agent-executor-report-ready")
        self.assertEqual(self.store.task("REALTIME-CONTROLLER")["status"], "IN_PROGRESS")

    def test_github_outage_trips_circuit_breaker(self):
        self.github.fail_main = True
        for _ in range(rc.CIRCUIT_THRESHOLD):
            with self.assertRaises(rc.ControllerError):
                self.controller.reconcile()
        self.assertEqual(self.store.get_meta("controller_state"), "DEGRADED")

    def test_status_never_contains_secret_and_safety_defaults_are_false(self):
        text = json.dumps(self.store.snapshot())
        self.assertNotIn(SECRET, text)
        safety = self.store.snapshot()["safety"]
        self.assertFalse(safety["LIVE_TRADING"])
        self.assertFalse(safety["REAL_ORDER_ALLOWED"])
        self.assertFalse(safety["PRIVATE_TRADING_API_ALLOWED"])
        self.assertEqual(safety["realOrders"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
