#!/usr/bin/env python3
"""Strict, reusable GitHub evidence validation for Agent Hub schema-v2 reports."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping, Protocol, Sequence

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
    """A structured, fail-closed mismatch suitable for an Issue audit report."""

    def __init__(
        self,
        code: str,
        stage: str,
        expected: Any,
        actual: Any,
        *,
        evidence_ids: Sequence[str] = (),
        retryable: bool = False,
    ) -> None:
        self.code = code
        self.stage = stage
        self.expected = expected
        self.actual = actual
        self.evidence_ids = tuple(evidence_ids)
        self.retryable = retryable
        super().__init__(self.audit_message())

    def audit_message(self) -> str:
        def clean(value: Any) -> str:
            return re.sub(r"\s+", " ", json.dumps(value, ensure_ascii=False, sort_keys=True, default=str))[:500]
        return (
            f"error_code={self.code}; stage={self.stage}; expected={clean(self.expected)}; "
            f"actual={clean(self.actual)}; retryable={'yes' if self.retryable else 'no'}"
        )


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
    merged: bool
    repository: str
    author: str
    base_branch: str
    base_sha: str
    head_branch: str
    head_sha: str
    body: str


@dataclass(frozen=True)
class ValidatedGitHubEvidence:
    evidence_ids: tuple[str, ...]
    pr: PullRequestEvidence | None
    run_id: int | None
    run_conclusion: str
    branch_sha: str
    base_branch_sha: str
    reported_changed_files: tuple[str, ...]
    pr_changed_files: tuple[str, ...]


def _repo_name(value: Any) -> str:
    return str(value.get("full_name") or "") if isinstance(value, Mapping) else ""


def _evidence_id(kind: str, payload: Mapping[str, Any]) -> str:
    canonical = json.dumps(dict(payload), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"gh-evidence-v2:{kind}:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:24]}"


def _mismatch(code: str, stage: str, expected: Any, actual: Any, evidence_ids: Sequence[str] = ()) -> GitHubEvidenceError:
    return GitHubEvidenceError(code, stage, expected, actual, evidence_ids=evidence_ids)


def _pull_evidence(payload: Mapping[str, Any]) -> PullRequestEvidence:
    base = payload.get("base") if isinstance(payload.get("base"), Mapping) else {}
    head = payload.get("head") if isinstance(payload.get("head"), Mapping) else {}
    user = payload.get("user") if isinstance(payload.get("user"), Mapping) else {}
    evidence = PullRequestEvidence(
        number=int(payload.get("number") or 0),
        state=str(payload.get("state") or ""),
        draft=bool(payload.get("draft")),
        merged=bool(payload.get("merged")),
        repository=_repo_name(base.get("repo")),
        author=str(user.get("login") or ""),
        base_branch=str(base.get("ref") or ""),
        base_sha=str(base.get("sha") or "").lower(),
        head_branch=str(head.get("ref") or ""),
        head_sha=str(head.get("sha") or "").lower(),
        body=str(payload.get("body") or ""),
    )
    if evidence.number <= 0 or not SHA_RE.fullmatch(evidence.base_sha) or not SHA_RE.fullmatch(evidence.head_sha):
        raise _mismatch("pr_evidence_incomplete", "pull_request", "positive number and two 40-char SHAs", payload)
    if _repo_name(head.get("repo")) != evidence.repository:
        raise _mismatch("pr_cross_repository", "pull_request", evidence.repository, _repo_name(head.get("repo")))
    return evidence


def fetch_pull_request(github: GitHubLike, number: int) -> PullRequestEvidence:
    if number <= 0:
        raise _mismatch("pr_number_invalid", "pull_request", "positive integer", number)
    payload = github.request("GET", f"/repos/{github.repository}/pulls/{number}")
    if not isinstance(payload, Mapping):
        raise _mismatch("pr_not_found", "pull_request", f"PR #{number}", type(payload).__name__)
    return _pull_evidence(payload)


def _parse_changed_files(raw: str) -> tuple[str, ...]:
    text = str(raw or "").strip()
    if not text or text.lower() in {"none", "[]"}:
        return ()
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise _mismatch("changed_files_invalid_json", "report_schema", "JSON string list", text) from exc
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise _mismatch("changed_files_invalid_type", "report_schema", "string list", value)
    return tuple(dict.fromkeys(item.strip().replace("\\", "/") for item in value if item.strip()))


def _pr_files(github: GitHubLike, number: int) -> tuple[str, ...]:
    files: list[str] = []
    for page in range(1, 4):
        payload = github.request("GET", f"/repos/{github.repository}/pulls/{number}/files?per_page=100&page={page}")
        if not isinstance(payload, list):
            raise _mismatch("pr_files_invalid_response", "pull_request_files", "list", type(payload).__name__)
        files.extend(str(item.get("filename") or "") for item in payload if isinstance(item, Mapping))
        if len(payload) < 100:
            break
    return tuple(sorted(dict.fromkeys(path for path in files if path)))


def _latest_statuses(github: GitHubLike, sha: str) -> dict[str, str]:
    payload = github.request("GET", f"/repos/{github.repository}/commits/{sha}/status")
    statuses = payload.get("statuses") if isinstance(payload, Mapping) else None
    if not isinstance(statuses, list):
        raise _mismatch("commit_status_invalid_response", "required_statuses", "statuses list", payload)
    latest: dict[str, str] = {}
    for item in statuses:
        if isinstance(item, Mapping):
            context = str(item.get("context") or "")
            if context and context not in latest:
                latest[context] = str(item.get("state") or "")
    return latest


def validate_required_statuses(github: GitHubLike, sha: str) -> tuple[str, ...]:
    latest = _latest_statuses(github, sha)
    failed = {context: latest.get(context, "missing") for context in REQUIRED_STATUS_CONTEXTS if latest.get(context) != "success"}
    if failed:
        raise _mismatch("required_status_not_success", "required_statuses", {c: "success" for c in REQUIRED_STATUS_CONTEXTS}, failed)
    return tuple(REQUIRED_STATUS_CONTEXTS)


def validate_report_evidence(
    report: Any,
    github: GitHubLike,
    *,
    issue_number: int,
    report_comment: Mapping[str, Any],
) -> ValidatedGitHubEvidence:
    """Re-query every referenced GitHub object and return non-empty immutable IDs."""
    fields = report.fields
    ids: list[str] = []
    comment_id = int(report_comment.get("id") or 0)
    comment_author = str((report_comment.get("user") or {}).get("login") or "")
    report_comment_id = int(getattr(report, "comment_id", 0) or 0)
    report_author = str(getattr(report, "author", "") or "")
    if issue_number <= 0 or comment_id != report_comment_id or comment_author != report_author:
        raise _mismatch(
            "report_comment_identity_mismatch",
            "issue_comment",
            {"issue": issue_number, "comment": report_comment_id, "author": report_author},
            {"issue": issue_number, "comment": comment_id, "author": comment_author},
        )
    ids.append(_evidence_id("issue-comment", {"repository": github.repository, "issue": issue_number, "comment": comment_id, "author": comment_author}))

    report_sha = str(getattr(report, "head_sha", "") or "").lower()
    branch = str(getattr(report, "branch", "") or fields.get("branch") or "")
    if not SHA_RE.fullmatch(report_sha):
        raise _mismatch("report_head_sha_invalid", "branch_head", "40-char SHA", report_sha, ids)
    actual_branch_sha = str(github.branch_sha(branch) or "").lower()
    if actual_branch_sha != report_sha:
        raise _mismatch("branch_head_mismatch", "branch_head", report_sha, actual_branch_sha, ids)
    ids.append(_evidence_id("branch-head", {"repository": github.repository, "branch": branch, "sha": report_sha}))

    reported_base_sha = str(fields.get("base_sha") or "").lower()
    base_branch = str(fields.get("base_branch") or "")
    if not SHA_RE.fullmatch(reported_base_sha):
        raise _mismatch("report_base_sha_invalid", "base_branch_head", "40-char SHA", reported_base_sha, ids)
    actual_base_branch_sha = str(github.branch_sha(base_branch) or "").lower()
    if actual_base_branch_sha != reported_base_sha:
        raise _mismatch("base_branch_head_mismatch", "base_branch_head", reported_base_sha, actual_base_branch_sha, ids)
    ids.append(_evidence_id("base-branch-head", {"repository": github.repository, "branch": base_branch, "sha": reported_base_sha}))

    run_id_text = str(fields.get("ci_run_id") or "none").strip().lower()
    run_id: int | None = None
    run_conclusion = "none"
    if run_id_text != "none":
        if not run_id_text.isdigit():
            raise _mismatch("ci_run_id_invalid", "workflow_run", "positive integer", run_id_text, ids)
        run_id = int(run_id_text)
        run = github.workflow_run(run_id)
        run_sha = str(run.get("head_sha") or "").lower()
        run_repo = _repo_name(run.get("repository"))
        run_status = str(run.get("status") or "")
        run_conclusion = str(run.get("conclusion") or "")
        if run_repo and run_repo != github.repository:
            raise _mismatch("workflow_repository_mismatch", "workflow_run", github.repository, run_repo, ids)
        if run_sha != report_sha:
            raise _mismatch("workflow_head_sha_mismatch", "workflow_run", report_sha, run_sha, ids)
        if run_status != "completed":
            raise _mismatch("workflow_not_completed", "workflow_run", "completed", run_status, ids)
        if str(report.status) == "completed" and run_conclusion != "success":
            raise _mismatch("completed_report_ci_not_success", "workflow_run", "success", run_conclusion, ids)
        ids.append(_evidence_id("workflow-run", {"repository": github.repository, "run_id": run_id, "head_sha": run_sha, "conclusion": run_conclusion}))
    elif str(report.status) == "completed":
        raise _mismatch("completed_report_ci_missing", "workflow_run", "numeric ci_run_id", run_id_text, ids)

    reported_changed = _parse_changed_files(str(fields.get("changed_files") or "[]"))
    pr_text = str(fields.get("pr_number") or "none").strip().lower()
    pr: PullRequestEvidence | None = None
    actual_pr_files: tuple[str, ...] = ()
    if pr_text != "none":
        if not pr_text.isdigit():
            raise _mismatch("pr_number_invalid", "pull_request", "positive integer or none", pr_text, ids)
        pr = fetch_pull_request(github, int(pr_text))
        expected_base = base_branch
        expected_head_branch = branch
        if pr.repository != github.repository:
            raise _mismatch("pr_repository_mismatch", "pull_request", github.repository, pr.repository, ids)
        if pr.state != "open" or pr.merged:
            raise _mismatch("pr_not_open", "pull_request", {"state": "open", "merged": False}, {"state": pr.state, "merged": pr.merged}, ids)
        if not pr.draft:
            raise _mismatch("pr_not_draft", "pull_request", True, pr.draft, ids)
        if pr.base_branch != expected_base:
            raise _mismatch("pr_base_branch_mismatch", "pull_request", expected_base, pr.base_branch, ids)
        if pr.base_sha != reported_base_sha:
            raise _mismatch("pr_base_sha_mismatch", "pull_request", reported_base_sha, pr.base_sha, ids)
        if pr.head_branch != expected_head_branch or pr.head_sha != report_sha:
            raise _mismatch("pr_head_identity_mismatch", "pull_request", {"branch": expected_head_branch, "sha": report_sha}, {"branch": pr.head_branch, "sha": pr.head_sha}, ids)
        actual_pr_files = _pr_files(github, pr.number)
        missing = sorted(set(reported_changed) - set(actual_pr_files))
        if missing:
            raise _mismatch("reported_files_not_in_pr", "pull_request_files", list(reported_changed), list(actual_pr_files), ids)
        if str(report.status) == "completed" and actual_pr_files and not reported_changed:
            raise _mismatch("completed_changed_files_empty", "pull_request_files", list(actual_pr_files), [], ids)
        ids.append(_evidence_id("pull-request", {"repository": github.repository, "number": pr.number, "base": pr.base_branch, "base_sha": pr.base_sha, "head": pr.head_branch, "head_sha": pr.head_sha, "draft": pr.draft}))
        ids.append(_evidence_id("pull-request-files", {"repository": github.repository, "number": pr.number, "files": list(actual_pr_files)}))
    elif reported_changed:
        raise _mismatch("changed_report_without_pr", "pull_request", "Draft PR number", list(reported_changed), ids)

    if str(report.status) == "completed":
        contexts = validate_required_statuses(github, report_sha)
        ids.append(_evidence_id("required-statuses", {"repository": github.repository, "sha": report_sha, "contexts": list(contexts)}))
    ids = list(dict.fromkeys(ids))
    if not ids:
        raise _mismatch("immutable_evidence_empty", "evidence_conversion", "at least one evidence ID", [], ids)
    return ValidatedGitHubEvidence(
        tuple(ids), pr, run_id, run_conclusion, actual_branch_sha, actual_base_branch_sha,
        reported_changed, actual_pr_files,
    )


def validate_completed_report(report: Any, github: GitHubLike) -> PullRequestEvidence | None:
    """Backward-compatible completed-report validation used by older callers/tests."""
    if str(report.status) != "completed":
        return None
    comment_id = int(getattr(report, "comment_id", 1) or 1)
    author = str(getattr(report, "author", "github-actions[bot]") or "github-actions[bot]")
    if not hasattr(report, "comment_id"):
        setattr(report, "comment_id", comment_id)
    if not hasattr(report, "author"):
        setattr(report, "author", author)
    if not hasattr(report, "branch"):
        setattr(report, "branch", str(report.fields.get("branch") or ""))
    dummy_comment = {"id": comment_id, "user": {"login": author}}
    return validate_report_evidence(report, github, issue_number=62, report_comment=dummy_comment).pr


def validate_draft_pr_reuse(
    payload: Mapping[str, Any], *, repository: str, repository_owner: str, work_branch: str,
    target_branch: str, command_id: str, worker: str, expected_head_sha: str,
) -> PullRequestEvidence:
    """Validate either a newly isolated Agent Hub Draft or a validated Draft continuation.

    When work_branch == target_branch the coordinator has already re-queried and sealed
    the existing Draft PR evidence. Reuse is therefore keyed by exact head identity,
    Draft state, repository, and trusted author rather than a command-specific PR body.
    New isolation branches retain the stronger command metadata contract.
    """
    evidence = _pull_evidence(payload)
    if evidence.repository != repository or evidence.state != "open" or evidence.merged or not evidence.draft:
        raise _mismatch("draft_pr_not_reusable", "draft_pr_reuse", "open same-repository Draft", {"repository": evidence.repository, "state": evidence.state, "draft": evidence.draft, "merged": evidence.merged})
    if evidence.author not in {repository_owner, "github-actions[bot]"}:
        raise _mismatch("draft_pr_author_untrusted", "draft_pr_reuse", [repository_owner, "github-actions[bot]"], evidence.author)
    if evidence.head_branch != work_branch:
        raise _mismatch("draft_pr_head_branch_mismatch", "draft_pr_reuse", work_branch, evidence.head_branch)

    continuation = work_branch == target_branch
    if continuation:
        if evidence.head_sha != expected_head_sha:
            raise _mismatch("draft_pr_head_sha_mismatch", "draft_pr_reuse", expected_head_sha, evidence.head_sha)
        if evidence.base_branch == evidence.head_branch:
            raise _mismatch("draft_pr_self_base", "draft_pr_reuse", "distinct base and head", evidence.base_branch)
        return evidence

    if evidence.base_branch != target_branch:
        raise _mismatch("draft_pr_branch_mismatch", "draft_pr_reuse", {"head": work_branch, "base": target_branch}, {"head": evidence.head_branch, "base": evidence.base_branch})
    required = {
        f"agent_hub_command_id: {command_id}", f"agent_hub_worker: {worker}",
        f"agent_hub_expected_head_sha: {expected_head_sha}", f"agent_hub_work_branch: {work_branch}",
    }
    if not all(marker in evidence.body for marker in required):
        raise _mismatch("draft_pr_metadata_mismatch", "draft_pr_reuse", sorted(required), evidence.body)
    return evidence


def self_test() -> int:
    class Fake:
        repository = "owner/repo"

        def __init__(
            self, *, conclusion="failure", run_sha="b" * 40, branch_sha="b" * 40,
            base_sha="a" * 40, pr_base="main", pr_base_sha="a" * 40,
            draft=True, files=None,
        ):
            self.conclusion = conclusion
            self.run_sha = run_sha
            self._branch_sha = branch_sha
            self._base_sha = base_sha
            self.pr_base = pr_base
            self.pr_base_sha = pr_base_sha
            self.draft = draft
            self.files = files or ["tests/x.spec.ts"]

        def workflow_run(self, run_id):
            return {"status": "completed", "conclusion": self.conclusion, "head_sha": self.run_sha, "repository": {"full_name": self.repository}}

        def branch_sha(self, branch):
            return self._base_sha if branch == "main" else self._branch_sha

        def request(self, method, path, payload=None):
            if "/files" in path:
                return [{"filename": f} for f in self.files]
            if "/pulls/" in path:
                return {
                    "number": 7, "state": "open", "draft": self.draft, "merged": False, "body": "",
                    "user": {"login": "owner"},
                    "base": {"ref": self.pr_base, "sha": self.pr_base_sha, "repo": {"full_name": self.repository}},
                    "head": {"ref": "feature/demo", "sha": "b" * 40, "repo": {"full_name": self.repository}},
                }
            return {"statuses": [{"context": c, "state": "success"} for c in REQUIRED_STATUS_CONTEXTS]}

    class Report:
        comment_id = 99
        author = "owner"
        status = "partial"
        head_sha = "b" * 40
        branch = "feature/demo"
        fields = {
            "ci_run_id": "42", "pr_number": "7", "changed_files": "[]", "repository": "owner/repo",
            "base_branch": "main", "base_sha": "a" * 40, "branch": "feature/demo",
        }

    comment = {"id": 99, "user": {"login": "owner"}}
    result = validate_report_evidence(Report(), Fake(), issue_number=62, report_comment=comment)
    assert result.evidence_ids and result.pr and result.pr.base_branch == "main"
    assert result.run_conclusion == "failure"
    cases = (
        ("branch_head_mismatch", Fake(branch_sha="c" * 40)),
        ("base_branch_head_mismatch", Fake(base_sha="c" * 40)),
        ("workflow_head_sha_mismatch", Fake(run_sha="c" * 40)),
        ("pr_base_branch_mismatch", Fake(pr_base="develop")),
        ("pr_base_sha_mismatch", Fake(pr_base_sha="c" * 40)),
        ("pr_not_draft", Fake(draft=False)),
    )
    for code, fake in cases:
        try:
            validate_report_evidence(Report(), fake, issue_number=62, report_comment=comment)
        except GitHubEvidenceError as exc:
            assert exc.code == code
        else:
            raise AssertionError(code)

    class Completed(Report):
        status = "completed"
        fields = dict(Report.fields, changed_files='["tests/x.spec.ts"]')

    completed = validate_report_evidence(Completed(), Fake(conclusion="success"), issue_number=62, report_comment=comment)
    assert len(completed.evidence_ids) >= 7
    try:
        validate_report_evidence(Completed(), Fake(conclusion="failure"), issue_number=62, report_comment=comment)
    except GitHubEvidenceError as exc:
        assert exc.code == "completed_report_ci_not_success"
    else:
        raise AssertionError("failed completed run accepted")

    continuation_payload = {
        "number": 9, "state": "open", "draft": True, "merged": False, "body": "manual draft body",
        "user": {"login": "owner"},
        "base": {"ref": "main", "sha": "a" * 40, "repo": {"full_name": "owner/repo"}},
        "head": {"ref": "feature/demo", "sha": "b" * 40, "repo": {"full_name": "owner/repo"}},
    }
    reused = validate_draft_pr_reuse(
        continuation_payload, repository="owner/repo", repository_owner="owner",
        work_branch="feature/demo", target_branch="feature/demo", command_id="hub-9",
        worker="integration-planner", expected_head_sha="b" * 40,
    )
    assert reused.number == 9
    try:
        validate_draft_pr_reuse(
            continuation_payload, repository="owner/repo", repository_owner="owner",
            work_branch="feature/demo", target_branch="feature/demo", command_id="hub-9",
            worker="integration-planner", expected_head_sha="c" * 40,
        )
    except GitHubEvidenceError as exc:
        assert exc.code == "draft_pr_head_sha_mismatch"
    else:
        raise AssertionError("stale Draft continuation was accepted")

    print(json.dumps({
        "github_evidence_v2": "pass", "partial_failed_run_reusable": 1,
        "empty_evidence_accepted": 0, "detailed_mismatch_codes": len(cases),
        "required_statuses": len(REQUIRED_STATUS_CONTEXTS), "base_sha_verified": 1,
        "existing_draft_continuation": 1, "stale_draft_continuation_accepted": 0,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(self_test())
