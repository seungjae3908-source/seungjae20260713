#!/usr/bin/env python3
"""Strict GitHub evidence validation for Agent Hub completed reports and Draft PR reuse."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Mapping, Protocol, Sequence
from urllib.parse import quote, urlencode

REQUIRED_STATUS_CONTEXTS = (
    "application-ci/verified",
    "browser-ui/verified",
    "security-integration/verified",
    "ai-privacy/verified",
    "database-rls/verified",
    "futures-public-network-smoke/verified",
)
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class GitHubEvidenceError(RuntimeError):
    """Fail-closed GitHub contract mismatch without sensitive response bodies."""


class GitHubLike(Protocol):
    repository: str

    def request(self, method: str, path: str, payload: Mapping[str, Any] | None = None) -> Any: ...
    def workflow_run(self, run_id: int) -> dict[str, Any]: ...
    def branch_sha(self, branch: str) -> str: ...


@dataclass(frozen=True)
class PullRequestEvidence:
    number: int
    state: str
    draft: bool
    repository: str
    author: str
    base_branch: str
    base_sha: str
    head_branch: str
    head_sha: str
    body: str


def _repo_name(value: Any) -> str:
    if isinstance(value, Mapping):
        return str(value.get("full_name") or "")
    return ""


def _pull_evidence(payload: Mapping[str, Any]) -> PullRequestEvidence:
    base = payload.get("base") if isinstance(payload.get("base"), Mapping) else {}
    head = payload.get("head") if isinstance(payload.get("head"), Mapping) else {}
    user = payload.get("user") if isinstance(payload.get("user"), Mapping) else {}
    number = int(payload.get("number") or 0)
    evidence = PullRequestEvidence(
        number=number,
        state=str(payload.get("state") or ""),
        draft=bool(payload.get("draft")),
        repository=_repo_name(base.get("repo")),
        author=str(user.get("login") or ""),
        base_branch=str(base.get("ref") or ""),
        base_sha=str(base.get("sha") or "").lower(),
        head_branch=str(head.get("ref") or ""),
        head_sha=str(head.get("sha") or "").lower(),
        body=str(payload.get("body") or ""),
    )
    if number <= 0 or not SHA_RE.fullmatch(evidence.base_sha) or not SHA_RE.fullmatch(evidence.head_sha):
        raise GitHubEvidenceError("pull request evidence is incomplete")
    if _repo_name(head.get("repo")) != evidence.repository:
        raise GitHubEvidenceError("pull request crosses repositories")
    return evidence


def fetch_pull_request(github: GitHubLike, number: int) -> PullRequestEvidence:
    if number <= 0:
        raise GitHubEvidenceError("pr_number must be positive")
    payload = github.request("GET", f"/repos/{github.repository}/pulls/{number}")
    if not isinstance(payload, Mapping):
        raise GitHubEvidenceError("pull request does not exist")
    return _pull_evidence(payload)


def _parse_changed_files(raw: str) -> tuple[str, ...]:
    text = str(raw or "").strip()
    if not text or text.lower() in {"none", "[]"}:
        return ()
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise GitHubEvidenceError("changed_files is not valid JSON") from exc
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise GitHubEvidenceError("changed_files is not a string list")
    return tuple(value)


def _latest_statuses(github: GitHubLike, sha: str) -> dict[str, str]:
    payload = github.request("GET", f"/repos/{github.repository}/commits/{sha}/status")
    if not isinstance(payload, Mapping):
        raise GitHubEvidenceError("combined status response is invalid")
    statuses = payload.get("statuses")
    if not isinstance(statuses, list):
        raise GitHubEvidenceError("combined status list is missing")
    latest: dict[str, str] = {}
    for item in statuses:
        if not isinstance(item, Mapping):
            continue
        context = str(item.get("context") or "")
        if context and context not in latest:
            latest[context] = str(item.get("state") or "")
    return latest


def validate_required_statuses(github: GitHubLike, sha: str) -> None:
    latest = _latest_statuses(github, sha)
    failed = [context for context in REQUIRED_STATUS_CONTEXTS if latest.get(context) != "success"]
    if failed:
        raise GitHubEvidenceError("required status checks are not all success")


def validate_completed_report(report: Any, github: GitHubLike) -> PullRequestEvidence | None:
    """Validate immutable GitHub evidence before accepting a completed report.

    Read-only reports may use pr_number=none only when changed_files is empty. Any report
    that names a PR must prove same-repository, open base/head identity and all six required
    statuses. A workflow run conclusion must be exactly success and its head SHA must match
    for both human and bot reports.
    """
    if str(report.status) != "completed":
        return None
    fields = report.fields
    run_id_text = str(fields.get("ci_run_id") or "")
    if not run_id_text.isdigit():
        raise GitHubEvidenceError("completed report requires numeric ci_run_id")
    run = github.workflow_run(int(run_id_text))
    if str(run.get("status") or "") != "completed" or str(run.get("conclusion") or "") != "success":
        raise GitHubEvidenceError("workflow run is not an exact success")
    run_sha = str(run.get("head_sha") or "").lower()
    report_sha = str(report.head_sha or "").lower()
    if not SHA_RE.fullmatch(report_sha) or run_sha != report_sha:
        raise GitHubEvidenceError("workflow run head SHA mismatch")
    run_repo = _repo_name(run.get("repository"))
    if run_repo and run_repo != github.repository:
        raise GitHubEvidenceError("workflow run repository mismatch")

    pr_text = str(fields.get("pr_number") or "none").strip().lower()
    changed = _parse_changed_files(str(fields.get("changed_files") or "[]"))
    if pr_text == "none":
        if changed:
            raise GitHubEvidenceError("completed changed report requires an open Draft PR")
        return None
    if not pr_text.isdigit():
        raise GitHubEvidenceError("pr_number is invalid")

    evidence = fetch_pull_request(github, int(pr_text))
    expected_repo = str(fields.get("repository") or "")
    expected_base = str(fields.get("target_branch") or fields.get("base_branch") or "")
    expected_branch = str(fields.get("branch") or "")
    reported_base_sha = str(fields.get("base_sha") or "").lower()
    if evidence.repository != expected_repo or evidence.repository != github.repository:
        raise GitHubEvidenceError("pull request repository mismatch")
    if evidence.state != "open":
        raise GitHubEvidenceError("pull request is not open")
    if evidence.base_branch != expected_base:
        raise GitHubEvidenceError("pull request base branch mismatch")
    if evidence.head_branch != expected_branch or evidence.head_sha != report_sha:
        raise GitHubEvidenceError("pull request head mismatch")
    if reported_base_sha != evidence.base_sha:
        raise GitHubEvidenceError("reported base SHA does not match pull request base SHA")
    if github.branch_sha(expected_base) != evidence.base_sha:
        raise GitHubEvidenceError("pull request base SHA is stale")
    validate_required_statuses(github, report_sha)
    return evidence


def validate_draft_pr_reuse(
    payload: Mapping[str, Any],
    *,
    repository: str,
    repository_owner: str,
    work_branch: str,
    target_branch: str,
    command_id: str,
    worker: str,
    expected_head_sha: str,
) -> PullRequestEvidence:
    evidence = _pull_evidence(payload)
    if evidence.repository != repository or evidence.state != "open" or not evidence.draft:
        raise GitHubEvidenceError("existing pull request is not a reusable same-repository Draft")
    if evidence.head_branch != work_branch or evidence.base_branch != target_branch:
        raise GitHubEvidenceError("existing Draft PR branch identity mismatch")
    if evidence.author not in {repository_owner, "github-actions[bot]"}:
        raise GitHubEvidenceError("existing Draft PR author is not trusted")
    required = {
        f"agent_hub_command_id: {command_id}",
        f"agent_hub_worker: {worker}",
        f"agent_hub_expected_head_sha: {expected_head_sha}",
        f"agent_hub_work_branch: {work_branch}",
    }
    if not all(marker in evidence.body for marker in required):
        raise GitHubEvidenceError("existing Draft PR ownership metadata mismatch")
    return evidence


def self_test() -> int:
    class Fake:
        repository = "owner/repo"
        def __init__(self, *, conclusion: str = "success", run_sha: str = "b" * 40, state: str = "open", base_sha: str = "a" * 40, pr_base_sha: str = "a" * 40):
            self.conclusion = conclusion
            self.run_sha = run_sha
            self.state = state
            self.base_sha = base_sha
            self.pr_base_sha = pr_base_sha
        def workflow_run(self, run_id: int) -> dict[str, Any]:
            return {"status": "completed", "conclusion": self.conclusion, "head_sha": self.run_sha, "repository": {"full_name": self.repository}}
        def branch_sha(self, branch: str) -> str:
            return self.base_sha
        def request(self, method: str, path: str, payload=None):
            if "/pulls/" in path:
                return {"number": 7, "state": self.state, "draft": True, "body": "agent_hub_command_id: hub-1\nagent_hub_worker: integration-planner\nagent_hub_expected_head_sha: " + "b"*40 + "\nagent_hub_work_branch: agent/hub-1", "user": {"login": "github-actions[bot]"}, "base": {"ref": "main", "sha": self.pr_base_sha, "repo": {"full_name": self.repository}}, "head": {"ref": "feature/demo", "sha": "b"*40, "repo": {"full_name": self.repository}}}
            return {"statuses": [{"context": context, "state": "success"} for context in REQUIRED_STATUS_CONTEXTS]}
    class Report:
        status = "completed"; head_sha = "b" * 40; author = "github-actions[bot]"
        fields = {"ci_run_id":"42","pr_number":"7","changed_files":"[\"docs/x.md\"]","repository":"owner/repo","base_branch":"main","base_sha":"a"*40,"branch":"feature/demo"}
    assert validate_completed_report(Report(), Fake()) is not None
    for bad in (Fake(conclusion="neutral"), Fake(conclusion="skipped"), Fake(run_sha="d"*40), Fake(state="closed"), Fake(base_sha="d"*40), Fake(pr_base_sha="d"*40)):
        try:
            validate_completed_report(Report(), bad)
        except GitHubEvidenceError:
            pass
        else:
            raise AssertionError("invalid GitHub evidence was accepted")
    payload = Fake().request("GET", "/pulls/7")
    payload["head"]["ref"] = "agent/hub-1"
    validate_draft_pr_reuse(payload, repository="owner/repo", repository_owner="owner", work_branch="agent/hub-1", target_branch="main", command_id="hub-1", worker="integration-planner", expected_head_sha="b"*40)
    print(json.dumps({"github_evidence_v2":"pass","required_statuses":len(REQUIRED_STATUS_CONTEXTS),"neutral_accepted":0,"skipped_accepted":0,"base_sha_mismatch_accepted":0}))
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
