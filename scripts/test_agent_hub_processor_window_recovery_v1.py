from __future__ import annotations

import unittest
from typing import Any

from scripts import agent_hub_rollover_v2 as rollover
from scripts.agent_hub_processor_window_recovery_v1 import (
    BoundedCommentWindow,
    MAX_LEDGER_ANCHOR_LOOKBACK_COMMENTS,
    ProcessorWindowRecoveryError,
    augment_successor_body,
    assert_manual_invocation,
    coordinator_actionable_control_comments,
    expected_confirmation,
    latest_complete_ledger,
    read_bounded_comment_window,
    resolve_complete_ledger_anchor,
    validate_continuity_anchors,
)


class FakeGitHub:
    repository = "owner/repo"

    def __init__(self, pages: dict[int, Any]) -> None:
        self.pages = pages
        self.requests: list[str] = []

    def request(self, method: str, path: str, payload=None):
        self.assert_get(method)
        self.requests.append(path)
        page = int(path.split("page=")[-1])
        return self.pages.get(page, [])

    @staticmethod
    def assert_get(method: str) -> None:
        if method != "GET":
            raise AssertionError("unexpected mutation")


def comment(cid: int, body: str) -> dict[str, Any]:
    return {"id": cid, "body": body}


def worker_report(cid: int, worker: str) -> dict[str, Any]:
    return {
        "id": cid,
        "body": "\n".join([
            "[WORKER_REPORT]", "schema_version: 2", "task_id: demo-task",
            f"worker: {worker}", "repository: owner/repo", "base_branch: main",
            f"base_sha: {'a' * 40}", "branch: feature/demo", "status: partial",
            f"head_sha: {'b' * 40}", "pr_number: none", "changed_files: []",
            "checks: focused checks pending", "ci_run_id: none", "summary: bounded report",
            "remaining: continue safely", "dependencies: none", "conflicts: none",
            "approval_required: no", "prohibited_actions_confirmed: yes, no prohibited actions performed",
        ]),
        "user": {"login": "owner"}, "author_association": "OWNER",
    }


class ProcessorWindowRecoveryTests(unittest.TestCase):
    def test_confirmation_is_issue_scoped(self) -> None:
        self.assertEqual(expected_confirmation(660), "RECOVER_ISSUE_660_PROCESSOR_OVERFLOW")
        assert_manual_invocation(
            source_issue=660,
            confirmation="RECOVER_ISSUE_660_PROCESSOR_OVERFLOW",
            environ={"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch"},
        )
        with self.assertRaises(ProcessorWindowRecoveryError):
            assert_manual_invocation(source_issue=660, confirmation="RECOVER_PROCESSOR_OVERFLOW", environ={})

    def test_actions_non_dispatch_is_rejected(self) -> None:
        with self.assertRaises(ProcessorWindowRecoveryError):
            assert_manual_invocation(
                source_issue=660,
                confirmation="RECOVER_ISSUE_660_PROCESSOR_OVERFLOW",
                environ={"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "schedule"},
            )

    def test_normal_sized_issue_is_rejected(self) -> None:
        with self.assertRaises(ProcessorWindowRecoveryError):
            read_bounded_comment_window(FakeGitHub({}), 660, 1000, 1000)

    def test_overflow_reads_only_last_processor_window(self) -> None:
        pages = {page: [comment(page * 100 + idx, "x") for idx in range(100)] for page in range(1, 12)}
        window = read_bounded_comment_window(FakeGitHub(pages), 660, 1094, 1000)
        self.assertEqual(window.source_total_comments, 1094)
        self.assertEqual(window.comments_examined, 1000)

    def test_overflow_reads_exact_tail_when_final_page_is_partial(self) -> None:
        pages: dict[int, list[dict[str, Any]]] = {}
        for page in range(1, 12):
            start = ((page - 1) * 100) + 1
            pages[page] = [comment(start + idx, "x") for idx in range(100)]
        pages[12] = [comment(cid, "x") for cid in range(1101, 1108)]
        github = FakeGitHub(pages)
        window = read_bounded_comment_window(github, 660, 1107, 1000)
        self.assertEqual(window.comments_examined, 1000)
        self.assertEqual(window.comments[0]["id"], 108)
        self.assertEqual(window.comments[-1]["id"], 1107)
        self.assertTrue(github.requests[0].endswith("page=2"))
        self.assertTrue(github.requests[-1].endswith("page=12"))

    def test_unregistered_schema_v2_owner_report_is_continuity_only(self) -> None:
        filtered = coordinator_actionable_control_comments((worker_report(10, "ChatGPT Direct Work"),), "owner/repo")
        self.assertEqual(filtered, ())
        self.assertEqual(rollover.unresolved_control_work(filtered), [])

    def test_registered_schema_v2_owner_report_still_blocks_rollover(self) -> None:
        filtered = coordinator_actionable_control_comments((worker_report(11, "ai-chart"),), "owner/repo")
        self.assertEqual(len(filtered), 1)
        self.assertEqual(rollover.unresolved_control_work(filtered), ["pending_report:11:demo-task"])

    def test_malformed_registered_schema_v2_report_still_blocks_rollover(self) -> None:
        malformed = worker_report(12, "ai-chart")
        malformed["body"] = str(malformed["body"]).replace("checks: focused checks pending\n", "")
        filtered = coordinator_actionable_control_comments((malformed,), "owner/repo")
        self.assertEqual(len(filtered), 1)
        self.assertEqual(rollover.unresolved_control_work(filtered), ["pending_report:12:demo-task"])

    def test_missing_required_anchor_fails_closed(self) -> None:
        window = BoundedCommentWindow(
            comments=(
                comment(1, "[PIPELINE_SNAPSHOT]"), comment(2, "[LEASE]"),
                comment(3, "[PERSISTENT_TASK_LEDGER]\nrow\n[/PERSISTENT_TASK_LEDGER]"),
            ),
            source_total_comments=1100, comments_examined=3, processor_window=1000,
        )
        with self.assertRaisesRegex(ProcessorWindowRecoveryError, "WATCH_EVENT"):
            validate_continuity_anchors(window)

    def test_explicitly_closed_ledger_is_preserved(self) -> None:
        ledger_id, block = latest_complete_ledger((
            comment(1, "[PERSISTENT_TASK_LEDGER]\n- durable\n[/PERSISTENT_TASK_LEDGER]\n[NEXT_GATE]\nignored"),
        ))
        self.assertEqual(ledger_id, 1)
        self.assertEqual(block, "[PERSISTENT_TASK_LEDGER]\n- durable\n[/PERSISTENT_TASK_LEDGER]")

    def test_canonical_section_delimited_ledger_is_normalized(self) -> None:
        ledger_id, block = latest_complete_ledger((
            comment(2, "\n".join([
                "[PIPELINE_SNAPSHOT][CENTRAL_SCHEDULER]",
                "[PERSISTENT_TASK_LEDGER]",
                "- [HOLD] P0 account evidence",
                "- [HOLD] Product Runtime QA",
                "",
                "[NEXT_GATE]",
                "approval_required_now=yes",
            ])),
        ))
        self.assertEqual(ledger_id, 2)
        self.assertEqual(block, "\n".join([
            "[PERSISTENT_TASK_LEDGER]",
            "- [HOLD] P0 account evidence",
            "- [HOLD] Product Runtime QA",
            "[/PERSISTENT_TASK_LEDGER]",
        ]))
        self.assertNotIn("NEXT_GATE", block)

    def test_latest_unterminated_ledger_fails_closed(self) -> None:
        comments = (
            comment(1, "[PERSISTENT_TASK_LEDGER]\nold\n[/PERSISTENT_TASK_LEDGER]"),
            comment(2, "[PERSISTENT_TASK_LEDGER]\nnew-but-truncated"),
        )
        with self.assertRaisesRegex(ProcessorWindowRecoveryError, "incomplete"):
            latest_complete_ledger(comments)

    def test_empty_section_delimited_ledger_fails_closed(self) -> None:
        with self.assertRaisesRegex(ProcessorWindowRecoveryError, "incomplete"):
            latest_complete_ledger((comment(3, "[PERSISTENT_TASK_LEDGER]\n\n[NEXT_GATE]\nnext"),))

    def test_tail_ledger_uses_no_older_lookup(self) -> None:
        github = FakeGitHub({})
        window = BoundedCommentWindow(
            comments=(comment(1100, "[PERSISTENT_TASK_LEDGER]\n- current\n[NEXT_GATE]\nnext"),),
            source_total_comments=1100, comments_examined=1000, processor_window=1000,
        )
        ledger_id, block, examined = resolve_complete_ledger_anchor(github, 660, window)
        self.assertEqual(ledger_id, 1100)
        self.assertIn("- current", block)
        self.assertTrue(block.endswith("[/PERSISTENT_TASK_LEDGER]"))
        self.assertEqual(examined, 0)
        self.assertEqual(github.requests, [])

    def test_ledger_anchor_resolves_from_bounded_older_prefix(self) -> None:
        older = [comment(cid, "x") for cid in range(1, 101)]
        older[94] = comment(95, "[PERSISTENT_TASK_LEDGER]\n- durable\n[NEXT_GATE]\nnext")
        github = FakeGitHub({1: older})
        window = BoundedCommentWindow(
            comments=tuple(comment(cid, "tail") for cid in range(101, 1101)),
            source_total_comments=1100, comments_examined=1000, processor_window=1000,
        )
        ledger_id, block, examined = resolve_complete_ledger_anchor(github, 660, window)
        self.assertEqual(ledger_id, 95)
        self.assertIn("- durable", block)
        self.assertEqual(examined, 100)
        self.assertEqual(len(github.requests), 1)
        self.assertTrue(github.requests[0].endswith("page=1"))

    def test_newest_older_unterminated_ledger_fails_closed(self) -> None:
        older = [comment(cid, "x") for cid in range(1, 101)]
        older[79] = comment(80, "[PERSISTENT_TASK_LEDGER]\n- older-complete\n[/PERSISTENT_TASK_LEDGER]")
        older[89] = comment(90, "[PERSISTENT_TASK_LEDGER]\nnewest-truncated")
        github = FakeGitHub({1: older})
        window = BoundedCommentWindow(
            comments=tuple(comment(cid, "tail") for cid in range(101, 1101)),
            source_total_comments=1100, comments_examined=1000, processor_window=1000,
        )
        with self.assertRaisesRegex(ProcessorWindowRecoveryError, "incomplete"):
            resolve_complete_ledger_anchor(github, 660, window)

    def test_ledger_anchor_lookup_budget_exhaustion_fails_before_fetch(self) -> None:
        github = FakeGitHub({})
        window = BoundedCommentWindow(
            comments=tuple(comment(cid, "tail") for cid in range(1502, 2502)),
            source_total_comments=2501, comments_examined=1000, processor_window=1000,
        )
        with self.assertRaisesRegex(ProcessorWindowRecoveryError, "lookback budget"):
            resolve_complete_ledger_anchor(github, 660, window, max_lookback_comments=MAX_LEDGER_ANCHOR_LOOKBACK_COMMENTS)
        self.assertEqual(github.requests, [])

    def test_ledger_anchor_lookup_malformed_page_fails_closed(self) -> None:
        github = FakeGitHub({1: "not-a-list"})
        window = BoundedCommentWindow(
            comments=tuple(comment(cid, "tail") for cid in range(101, 1101)),
            source_total_comments=1100, comments_examined=1000, processor_window=1000,
        )
        with self.assertRaisesRegex(ProcessorWindowRecoveryError, "not a list"):
            resolve_complete_ledger_anchor(github, 660, window)

    def test_resolved_older_ledger_id_does_not_expand_tail_control_set(self) -> None:
        window = BoundedCommentWindow(
            comments=(comment(101, "[PIPELINE_SNAPSHOT]"), comment(102, "[LEASE]"), comment(103, "[WATCH_EVENT]")),
            source_total_comments=1100, comments_examined=1000, processor_window=1000,
        )
        anchors = validate_continuity_anchors(window, ledger_id=95)
        self.assertEqual(anchors["[PERSISTENT_TASK_LEDGER]"], 95)
        filtered = coordinator_actionable_control_comments(window.comments, "owner/repo")
        self.assertEqual(rollover.unresolved_control_work(filtered), [])

    def test_complete_continuity_anchors_pass(self) -> None:
        window = BoundedCommentWindow(
            comments=(
                comment(1, "[PIPELINE_SNAPSHOT]"), comment(2, "[LEASE]"), comment(3, "[WATCH_EVENT]"),
                comment(4, "[PERSISTENT_TASK_LEDGER]\n- task: open\n[NEXT_GATE]\nnext"),
            ),
            source_total_comments=1100, comments_examined=4, processor_window=1000,
        )
        anchors = validate_continuity_anchors(window)
        self.assertEqual(anchors["[PERSISTENT_TASK_LEDGER]"], 4)

    def test_successor_body_marks_bounded_not_full_history(self) -> None:
        window = BoundedCommentWindow(comments=(), source_total_comments=1094, comments_examined=994, processor_window=1000)
        anchors = {"[PIPELINE_SNAPSHOT]": 10, "[LEASE]": 11, "[WATCH_EVENT]": 12, "[PERSISTENT_TASK_LEDGER]": 13}
        body = augment_successor_body(
            "## standard\n<!-- agent-hub-canonical:v2 -->\n",
            window=window, anchors=anchors,
            ledger_block="[PERSISTENT_TASK_LEDGER]\n- keep-me\n[/PERSISTENT_TASK_LEDGER]",
            sanitizer=lambda value: value,
            ledger_anchor_lookup_comments_examined=94,
        )
        self.assertIn("history_validation_mode: `bounded_overflow_recovery`", body)
        self.assertIn("full_history_validated: `false`", body)
        self.assertIn("source_total_comments: `1094`", body)
        self.assertIn("processor_window_comments_examined: `994`", body)
        self.assertIn("ledger_anchor_lookup_comments_examined: `94`", body)
        self.assertIn("continuity-only older-prefix lookup", body)
        self.assertIn("explicit close marker or next canonical top-level section marker", body)
        self.assertIn("executable pending-control validation remains", body)
        self.assertIn("- keep-me", body)
        self.assertIn("<!-- agent-hub-canonical:v2 -->", body)


if __name__ == "__main__":
    unittest.main()
