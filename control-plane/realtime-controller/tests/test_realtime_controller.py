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

MODULE_PATH = Path(__file__).resolve().parents[1] / "realtime_controller.py"
spec = importlib.util.spec_from_file_location("realtime_controller", MODULE_PATH)
assert spec and spec.loader
rc = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rc
spec.loader.exec_module(rc)


class FakeGitHub:
    def __init__(self, comments=None):
        self.comments = list(comments or [])
        self.dispatches = []

    def issue_comments(self, issue_number=660):
        return list(self.comments)

    def repository_dispatch(self, event_type, client_payload):
        self.dispatches.append((event_type, dict(client_payload)))


class FakeAdapter:
    def __init__(self):
        self.dispatches = []

    def dispatch(self, task_id, command_version, dispatch_key):
        payload = {
            "source": "realtime-controller",
            "task_id": task_id,
            "command_version": command_version,
            "controller_dispatch_key": dispatch_key,
        }
        self.dispatches.append(payload)
        return payload


def command_comment(comment_id=100, add="TEST-A,TEST-B", keep="", complete=""):
    return {
        "id": comment_id,
        "body": "\n".join(
            [
                "[COMMAND_UPDATE]",
                "COMMAND_VERSION=007",
                "PUBLISHER=CENTRAL-COMMANDER",
                f"KEEP={keep}",
                f"ADD={add}",
                f"COMPLETE={complete}",
            ]
        ),
    }


def worker_report(comment_id, task_id, status="completed"):
    return {
        "id": comment_id,
        "body": "\n".join(
            [
                "[WORKER_REPORT]",
                "schema_version: 2",
                f"task_id: {task_id}",
                "worker: TEST-WORKER",
                f"status: {status}",
            ]
        ),
    }


class RealtimeControllerTests(unittest.TestCase):
    def test_signature_validation(self):
        secret = "test-secret"
        body = b'{"zen":"keep it logically awesome"}'
        signature = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        self.assertTrue(rc.validate_signature(secret, body, signature))
        self.assertFalse(rc.validate_signature(secret, body + b"x", signature))
        self.assertFalse(rc.validate_signature("", body, signature))

    def test_command_parser_requires_version_and_tracks_sets(self):
        parsed = rc.parse_command(command_comment()["body"], comment_id=100)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.version, 7)
        self.assertEqual(parsed.publisher, "CENTRAL-COMMANDER")
        self.assertEqual(parsed.add, ("TEST-A", "TEST-B"))
        self.assertEqual(parsed.source_comment_id, 100)

    def test_unauthorized_command_publisher_fails_closed(self):
        body = "\n".join(
            [
                "[COMMAND_UPDATE]",
                "COMMAND_VERSION=008",
                "PUBLISHER=NOT-CENTRAL",
                "ADD=TEST-X",
            ]
        )
        parsed = rc.parse_command(body, comment_id=8)
        with tempfile.TemporaryDirectory() as temp:
            store = rc.StateStore(Path(temp) / "controller.db")
            try:
                with self.assertRaises(rc.ControllerError):
                    store.apply_command(parsed)
            finally:
                store.close()

    def test_delivery_dedupe_is_persistent(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "controller.db"
            store = rc.StateStore(path)
            self.assertTrue(store.record_delivery("delivery-1", "push", {"a": 1}, now=10))
            self.assertFalse(store.record_delivery("delivery-1", "push", {"a": 1}, now=11))
            store.close()
            reopened = rc.StateStore(path)
            try:
                self.assertFalse(reopened.record_delivery("delivery-1", "push", {"a": 1}, now=12))
            finally:
                reopened.close()

    def test_crash_restart_does_not_duplicate_dispatched_worker(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "controller.db"
            first = rc.StateStore(path)
            parsed = rc.parse_command(command_comment(add="TEST-A")["body"], comment_id=100)
            first.apply_command(parsed, now=100)
            adapter1 = FakeAdapter()
            controller1 = rc.Controller(first, FakeGitHub(), adapter1, holder="controller-1", lease_ttl=1800)
            transition = controller1.run_until_blocked()
            self.assertEqual(transition["state"], "DISPATCHED")
            self.assertEqual(first.dispatch_count(), 1)
            self.assertEqual(len(adapter1.dispatches), 1)
            first.close()

            second = rc.StateStore(path)
            adapter2 = FakeAdapter()
            controller2 = rc.Controller(second, FakeGitHub(), adapter2, holder="controller-2", lease_ttl=1800)
            transition2 = controller2.run_until_blocked()
            try:
                self.assertEqual(transition2["state"], "WAITING_RESULT")
                self.assertEqual(second.dispatch_count(), 1)
                self.assertEqual(len(adapter2.dispatches), 0)
                self.assertEqual(second.task("TEST-A")["status"], "DISPATCHED")
            finally:
                second.close()

    def test_expired_inflight_fails_closed_instead_of_duplicate_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "controller.db"
            store = rc.StateStore(path)
            parsed = rc.parse_command(command_comment(add="TEST-A")["body"], comment_id=100)
            store.apply_command(parsed, now=100)
            self.assertTrue(store.acquire_task_lease("TEST-A", "controller-1", ttl=10, now=100))
            store.mark_dispatched(
                "TEST-A",
                "controller-1",
                {"source": "realtime-controller", "task_id": "TEST-A", "command_version": 7, "controller_dispatch_key": "7:TEST-A"},
                now=100,
            )
            try:
                self.assertEqual(store.block_expired_dispatches(now=111), 1)
                task = store.task("TEST-A")
                self.assertEqual(task["status"], "BLOCKED")
                self.assertEqual(task["blocker"], "LEASE_EXPIRED_REQUIRES_REMOTE_RECONCILE")
                self.assertIsNone(store.next_ready(now=111))
            finally:
                store.close()

    def test_controller_lease_and_heartbeat_prevent_double_controller(self):
        with tempfile.TemporaryDirectory() as temp:
            store = rc.StateStore(Path(temp) / "controller.db")
            try:
                self.assertTrue(store.acquire_controller_lease("one", ttl=30, now=100))
                self.assertFalse(store.acquire_controller_lease("two", ttl=30, now=101))
                self.assertTrue(store.heartbeat_controller("one", ttl=30, now=110))
                self.assertFalse(store.acquire_controller_lease("two", ttl=30, now=120))
                self.assertTrue(store.acquire_controller_lease("two", ttl=30, now=141))
            finally:
                store.close()

    def test_worker_result_event_auto_dispatches_second_task_without_chat_input(self):
        with tempfile.TemporaryDirectory() as temp:
            store = rc.StateStore(Path(temp) / "controller.db")
            github = FakeGitHub([command_comment()])
            adapter = FakeAdapter()
            controller = rc.Controller(store, github, adapter, holder="controller", lease_ttl=1800)
            try:
                controller.reconcile_remote()
                first = controller.run_until_blocked()
                self.assertEqual(first["taskId"], "TEST-A")
                self.assertEqual(len(adapter.dispatches), 1)

                github.comments.append(worker_report(101, "TEST-A", "completed"))
                result = controller.process_event(
                    "delivery-result-a",
                    "issue_comment",
                    {"issue": {"number": 660}, "comment": {"id": 101}},
                )
                self.assertTrue(result["reconcileTriggered"])
                self.assertEqual(result["transition"]["state"], "DISPATCHED")
                self.assertEqual(result["transition"]["taskId"], "TEST-B")
                self.assertEqual(store.task("TEST-A")["status"], "COMPLETE")
                self.assertEqual(store.task("TEST-B")["status"], "DISPATCHED")
                self.assertEqual(len(adapter.dispatches), 2)

                duplicate = controller.process_event(
                    "delivery-result-a",
                    "issue_comment",
                    {"issue": {"number": 660}, "comment": {"id": 101}},
                )
                self.assertTrue(duplicate["duplicate"])
                self.assertTrue(duplicate["eventDeduped"])
                self.assertEqual(len(adapter.dispatches), 2)
            finally:
                store.close()

    def test_startup_reconcile_recovers_missed_result_event(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "controller.db"
            store = rc.StateStore(path)
            github = FakeGitHub([command_comment(), worker_report(101, "TEST-A", "completed")])
            adapter = FakeAdapter()
            controller = rc.Controller(store, github, adapter, holder="controller")
            try:
                reconciliation = controller.reconcile_remote()
                transition = controller.run_until_blocked()
                self.assertEqual(reconciliation["commandVersion"], 7)
                self.assertEqual(store.task("TEST-A")["status"], "COMPLETE")
                self.assertEqual(transition["state"], "DISPATCHED")
                self.assertEqual(transition["taskId"], "TEST-B")
                self.assertEqual(len(adapter.dispatches), 1)
            finally:
                store.close()

    def test_existing_adapter_only_wakes_existing_agent_hub(self):
        github = FakeGitHub()
        adapter = rc.AgentHubWakeupAdapter(github)
        payload = adapter.dispatch("TEST-A", 7, "7:TEST-A")
        self.assertEqual(github.dispatches, [("agent-hub-wakeup", payload)])
        self.assertEqual(payload["source"], "realtime-controller")
        self.assertNotIn("code", payload)
        self.assertNotIn("production", json.dumps(payload).lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
