#!/usr/bin/env python3
"""Bounded proof helpers; no publisher, deployment, or trading implementation.

The existing #897 publisher remains the only writer. This helper reads code,
extracts ONE authenticated runner-local input, and verifies state/HTTP readback.
Only the two reviewed, self-contained Node modules below are eligible for reuse.
A future dependency/code change fails closed until this allowlist is reviewed.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import urllib.request
import zipfile

PINNED_BLOBS = {
    'research-production/bin/publish-v3-independence.mjs':
        '84bc304ea1e838d689b4b50238943bc7ce47f208',
    'research-production/src/v3-liquidity-independence-state-publisher.mjs':
        '260c8f60944e03f6f5cc44b9ee1e4ff5661fd5ab',
}
RESEARCH_ROOT = Path('/opt/investment-research')
STATE_ROOT = Path('/var/lib/investment-research-production')
SUMMARY_PATH = 'forward/liquidity/v3-authoritative-independence-summary.json'
SUMMARY_NAME = 'v3-authoritative-independence-summary.json'
MAX_JSON = 1024 * 1024
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'[0-9a-f]{64}')
OVERVIEW_FIELDS = (
    'schemaVersion', 'producerSha', 'upstreamIngestRunId',
    'upstreamIngestArtifactId', 'upstreamIngestArtifactDigest',
    'sourceInventoryDigest', 'targetSlotIndex', 'genuineScheduledSlotN',
    'rawAcceptedN', 'effectiveIndependentN', 'independentBuyN',
    'independentSellN', 'independenceAuditDigest',
    'independentSplitSourceDigest', 'v3IndependentSplitIndexDigest',
    'frozenSplitCounts', 'oosOutcomeCredit', 'calibrationArtifactProduced',
    'liquidityImpactStatus', 'fullCostReady', 'evidenceComplete',
    'executionAuthority', 'reportDigest',
)


class ProofError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise ProofError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data,
                        usedforsecurity=False).hexdigest()


def parse_json(data, limit=MAX_JSON):
    require(len(data) <= limit, 'JSON_SIZE_LIMIT')

    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'DUPLICATE_JSON_KEY')
            result[key] = value
        return result

    def constant(_):
        raise ProofError('NONFINITE_JSON')

    value = json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
    require(isinstance(value, dict), 'JSON_OBJECT_REQUIRED')
    return value


def read_plain(root, relative, limit=MAX_JSON):
    root = Path(root)
    require(root.is_absolute() and root.resolve() == root and
            root.is_dir() and not root.is_symlink(), 'ROOT_UNSAFE')
    parts = Path(relative).parts
    require(parts and not Path(relative).is_absolute() and
            all(p not in ('.', '..') for p in parts), 'PATH_UNSAFE')
    path = root
    for index, part in enumerate(parts):
        path = path / part
        mode = path.lstat().st_mode
        require(not stat.S_ISLNK(mode), 'SYMLINK_REJECTED')
        require(stat.S_ISREG(mode) if index == len(parts) - 1
                else stat.S_ISDIR(mode), 'PATH_TYPE_INVALID')
    # O_NOFOLLOW protects the final component against a symlink swap.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(os.fstat(fd).st_size <= limit, 'FILE_SIZE_LIMIT')
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            data = handle.read(limit + 1)
        require(len(data) <= limit, 'FILE_SIZE_LIMIT')
        return data
    finally:
        os.close(fd)


def git(root, *args):
    # No credentials, hooks, filters, shell evaluation or repository writes.
    environment = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
                   'HOME': '/nonexistent', 'GIT_CONFIG_NOSYSTEM': '1',
                   'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_NO_REPLACE_OBJECTS': '1'}
    return subprocess.check_output(
        ['git', '-c', 'core.hooksPath=/dev/null', '-c',
         f'safe.directory={root}', '-C', str(root), *args],
        env=environment, stderr=subprocess.DEVNULL, timeout=15,
    ).decode().strip()


def code_files(root, revision):
    require(bool(SHA.fullmatch(revision)), 'CODE_SHA_INVALID')
    require(git(root, 'rev-parse', '--show-toplevel') == str(root), 'GIT_ROOT_MISMATCH')
    require(git(root, 'rev-parse', 'HEAD') == revision, 'HEAD_MISMATCH')
    result = {}
    for path, pinned in PINNED_BLOBS.items():
        tree = git(root, 'ls-tree', revision, '--', path).split()
        require(len(tree) == 4 and tree[0] in ('100644', '100755') and
                tree[1] == 'blob' and tree[2] == pinned and tree[3] == path,
                'UNREVIEWED_PUBLISHER_CODE')
        data = read_plain(root, path)
        require(blob(data) == pinned, 'DIRTY_PUBLISHER_CODE')
        result[path] = {'blobSha': pinned, 'sha256': digest(data)}
    return result


def build_code_proof(root, control_sha):
    root = Path(root)
    files = code_files(root, control_sha)
    return {'schemaVersion': 'v3-publication-code-proof-v1',
            'controlSha': control_sha, 'files': files}


def decode_proof(encoded):
    require(len(encoded) <= 16384, 'CODE_PROOF_SIZE_LIMIT')
    value = parse_json(base64.b64decode(encoded, validate=True))
    require(value.get('schemaVersion') == 'v3-publication-code-proof-v1' and
            isinstance(value.get('controlSha'), str) and
            bool(SHA.fullmatch(value['controlSha'])), 'CODE_PROOF_INVALID')
    files = value.get('files')
    require(isinstance(files, dict) and set(files) == set(PINNED_BLOBS), 'CODE_CLOSURE_MISMATCH')
    for path, pinned in PINNED_BLOBS.items():
        item = files[path]
        require(isinstance(item, dict) and item.get('blobSha') == pinned and
                isinstance(item.get('sha256'), str) and
                bool(DIGEST.fullmatch(item['sha256'])), 'CODE_FILE_PROOF_INVALID')
    return value


def verify_runtime(proof, research_root=RESEARCH_ROOT, state_root=STATE_ROOT):
    research_root, state_root = Path(research_root), Path(state_root)
    require(research_root.is_absolute() and research_root.resolve() == research_root,
            'RESEARCH_ROOT_UNSAFE')
    releases = research_root / 'releases'
    require(releases.is_dir() and not releases.is_symlink(), 'RELEASES_UNSAFE')
    current = research_root / 'current'
    require(current.is_symlink(), 'CURRENT_NOT_SYMLINK')
    release = current.resolve(strict=True)
    require(release.parent == releases and bool(SHA.fullmatch(release.name)),
            'CURRENT_RELEASE_UNSAFE')
    require(release.is_dir() and not release.is_symlink() and
            (release / '.git').is_dir() and not (release / '.git').is_symlink(),
            'RELEASE_CHECKOUT_UNSAFE')
    files = code_files(release, release.name)
    require(canonical(files) == canonical(proof['files']), 'RUNTIME_CODE_NOT_EQUIVALENT')
    require(state_root.is_absolute() and state_root.is_dir() and
            not state_root.is_symlink() and state_root.resolve() == state_root,
            'STATE_ROOT_UNSAFE')
    require(current.resolve(strict=True) == release, 'CURRENT_CHANGED')
    return {'schemaVersion': 'v3-publication-runtime-proof-v1',
            'controlSha': proof['controlSha'], 'runtimeSha': release.name,
            'releaseRoot': str(release), 'stateRoot': str(state_root),
            'codeEquivalent': True, 'files': files}


def check_ancestor(root, control_sha, runtime):
    local = build_code_proof(Path(root), control_sha)
    require(runtime.get('controlSha') == control_sha and
            runtime.get('codeEquivalent') is True and
            isinstance(runtime.get('runtimeSha'), str) and
            bool(SHA.fullmatch(runtime['runtimeSha'])) and
            canonical(runtime.get('files')) == canonical(local['files']),
            'RUNTIME_PROOF_MISMATCH')
    try:
        git(root, 'merge-base', '--is-ancestor', runtime['runtimeSha'], control_sha)
    except subprocess.CalledProcessError as error:
        raise ProofError('RUNTIME_NOT_APPROVED_ANCESTOR') from error
    return runtime['runtimeSha']


def extract_summary(archive, expected_digest, output):
    require(bool(re.fullmatch(r'sha256:[0-9a-f]{64}', expected_digest)), 'ARTIFACT_DIGEST_INVALID')
    archive = Path(archive)
    require(archive.stat().st_size <= 64 * MAX_JSON, 'ARCHIVE_SIZE_LIMIT')
    data = archive.read_bytes()
    require(digest(data) == expected_digest[7:], 'ARTIFACT_DIGEST_MISMATCH')
    with zipfile.ZipFile(archive) as source:
        matches = [item for item in source.infolist() if item.filename == SUMMARY_NAME]
        require(len(matches) == 1, 'SUMMARY_CARDINALITY_INVALID')
        item = matches[0]
        mode = item.external_attr >> 16
        require(not item.is_dir() and not stat.S_ISLNK(mode) and
                not (item.flag_bits & 1) and item.file_size <= MAX_JSON,
                'SUMMARY_ENTRY_UNSAFE')
        body = source.read(item)  # validates this member's CRC; never extracts other paths
        parse_json(body)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(body)
    return {'archiveDigest': expected_digest, 'summaryFileDigest': digest(body)}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProofError('OVERVIEW_REDIRECT_REJECTED')


def snapshot(proof, expected_runtime_sha):
    before = verify_runtime(proof)
    require(before['runtimeSha'] == expected_runtime_sha, 'RUNTIME_CHANGED')
    state = read_plain(STATE_ROOT, SUMMARY_PATH)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open('http://127.0.0.1:18090/api/research/overview', timeout=8) as response:
        require(response.status == 200, 'OVERVIEW_HTTP_FAILED')
        overview = parse_json(response.read(4 * MAX_JSON + 1), 4 * MAX_JSON)
    require(read_plain(STATE_ROOT, SUMMARY_PATH) == state, 'STATE_CHANGED_DURING_READBACK')
    require(canonical(verify_runtime(proof)) == canonical(before), 'RUNTIME_CHANGED')
    return {'schemaVersion': 'v3-publication-snapshot-v1', 'runtime': before,
            'fileDigest': digest(state), 'summary': parse_json(state), 'overview': overview}


def verify_readback(expected, source, publication, observed, control_sha, runtime_sha):
    # The unchanged Node publisher already enforces the full frozen economic policy.
    # Here we bind exact bytes/identities/projections, not generate or recalculate evidence.
    require(all(isinstance(item, dict) for item in (expected, source, publication, observed)),
            'READBACK_OBJECT_REQUIRED')
    require(isinstance(control_sha, str) and isinstance(runtime_sha, str) and
            bool(SHA.fullmatch(control_sha)) and bool(SHA.fullmatch(runtime_sha)), 'READBACK_SHA_INVALID')
    require(set(OVERVIEW_FIELDS) <= set(expected), 'SOURCE_FIELDS_MISSING')
    body = dict(expected)
    report = body.pop('reportDigest')
    require(isinstance(report, str) and digest(canonical(body)) == report, 'SOURCE_REPORT_DIGEST_INVALID')
    require(observed.get('schemaVersion') == 'v3-publication-snapshot-v1' and
            canonical(observed.get('summary')) == canonical(expected), 'STATE_SOURCE_MISMATCH')
    runtime = observed.get('runtime')
    require(isinstance(runtime, dict), 'READBACK_RUNTIME_INVALID')
    require(runtime.get('controlSha') == control_sha and runtime.get('runtimeSha') == runtime_sha and
            runtime.get('codeEquivalent') is True and runtime.get('stateRoot') == str(STATE_ROOT),
            'READBACK_RUNTIME_MISMATCH')
    require(publication.get('schemaVersion') == 'research-v3-independence-production-publication-result-v1' and
            publication.get('status') in ('PUBLISHED', 'UNCHANGED') and
            publication.get('codeSha') == runtime_sha and
            publication.get('stateRoot') == str(STATE_ROOT) and
            publication.get('targetPath') == str(STATE_ROOT / SUMMARY_PATH), 'PUBLICATION_IDENTITY_MISMATCH')
    require(isinstance(observed.get('fileDigest'), str) and
            bool(DIGEST.fullmatch(observed['fileDigest'])) and
            publication.get('fileDigest') == observed['fileDigest'], 'PUBLICATION_FILE_DIGEST_MISMATCH')
    for field in ('reportDigest', 'targetSlotIndex', 'effectiveIndependentN',
                  'independentBuyN', 'independentSellN', 'frozenSplitCounts'):
        require(field in publication and canonical(publication[field]) == canonical(expected[field]),
                f'PUBLICATION_SOURCE_MISMATCH:{field}')
    actual_source = publication.get('source')
    require(isinstance(actual_source, dict), 'PUBLICATION_SOURCE_INVALID')
    for field in ('workflowRunId', 'artifactId'):
        require(not isinstance(source.get(field), bool) and
                bool(re.fullmatch(r'[0-9]{6,20}', str(source.get(field, '')))) and
                str(actual_source.get(field)) == str(source[field]), f'SOURCE_ID_MISMATCH:{field}')
    for field in ('artifactName', 'artifactDigest'):
        require(field in source and actual_source.get(field) == source[field], f'SOURCE_BINDING_MISMATCH:{field}')
    require(source.get('headSha') == expected['producerSha'] and
            source.get('runAttempt') == 1 and type(source['runAttempt']) is int and
            source.get('workflowName') == 'Public Forward Liquidity V3 Independence Consume' and
            source.get('event') == 'workflow_run' and source.get('branch') == 'main' and
            source.get('conclusion') == 'success', 'AUTHENTICATED_SOURCE_MISMATCH')
    require(source['artifactName'] == f"public-forward-liquidity-v3-authoritative-independence-slot-{expected['targetSlotIndex']}-{source['workflowRunId']}-1" and
            isinstance(source['artifactDigest'], str) and
            bool(re.fullmatch(r'sha256:[0-9a-f]{64}', source['artifactDigest'])), 'SOURCE_ARTIFACT_INVALID')
    overview = observed.get('overview')
    require(isinstance(overview, dict), 'OVERVIEW_OBJECT_REQUIRED')
    require(overview.get('schemaVersion') == 'research-dashboard-overview-v1', 'OVERVIEW_SCHEMA_INVALID')
    safety = overview.get('safety')
    require(isinstance(safety, dict) and isinstance(overview.get('profitability'), dict) and
            isinstance(overview.get('research'), dict), 'OVERVIEW_SECTIONS_INVALID')
    require(safety.get('readOnlyDashboard') is True and
            all(safety.get(key) is False for key in ('liveTrading', 'privateApi',
                'orderAuthority', 'forbiddenAuthorityObserved')) and
            overview.get('profitability', {}).get('proven') is False, 'OVERVIEW_SAFETY_INVALID')
    li = overview.get('research', {}).get('liquidityIndependence', {})
    require(isinstance(li, dict), 'OVERVIEW_V3_OBJECT_REQUIRED')
    require(li.get('present') is True and li.get('status') == 'PRESENT', 'OVERVIEW_V3_NOT_PRESENT')
    for field in OVERVIEW_FIELDS:
        require(field in li and canonical(li[field]) == canonical(expected[field]), f'OVERVIEW_SOURCE_MISMATCH:{field}')
    for field, value in {'oosOutcomeCredit': 0, 'calibrationArtifactProduced': False,
                         'fullCostReady': False, 'evidenceComplete': 0,
                         'executionAuthority': 'NONE', 'liveTrading': False,
                         'privateApi': False, 'realOrders': 0}.items():
        require(field in publication and canonical(publication[field]) == canonical(value), f'PUBLICATION_SAFETY_INVALID:{field}')
    return {'schemaVersion': 'v3-publication-readback-proof-v1', 'status': 'VERIFIED',
            'controlSha': control_sha, 'runtimeSha': runtime_sha,
            'sourceRunId': str(source['workflowRunId']), 'artifactId': str(source['artifactId']),
            'artifactDigest': source['artifactDigest'], 'reportDigest': report,
            'fileDigest': observed['fileDigest'], 'targetSlotIndex': expected['targetSlotIndex'],
            'effectiveIndependentN': expected['effectiveIndependentN'],
            'independentBuyN': expected['independentBuyN'], 'independentSellN': expected['independentSellN'],
            'evidenceCredit': 0, 'executionAuthority': 'NONE'}


def main(argv):
    require(bool(argv), 'COMMAND_REQUIRED')
    command, *args = argv
    if command == 'code-proof' and len(args) == 2:
        result = build_code_proof(Path(args[0]), args[1])
        print(base64.b64encode(canonical(result)).decode())
        return
    if command == 'runtime-proof' and len(args) == 1:
        result = verify_runtime(decode_proof(args[0]))
    elif command == 'check-ancestor' and len(args) == 3:
        result = {'runtimeSha': check_ancestor(Path(args[0]), args[1], parse_json(Path(args[2]).read_bytes()))}
    elif command == 'extract-summary' and len(args) == 3:
        result = extract_summary(*args)
    elif command == 'snapshot' and len(args) == 2:
        result = snapshot(decode_proof(args[0]), args[1])
    elif command == 'verify-readback' and len(args) == 6:
        values = [parse_json(Path(path).read_bytes(), 6 * MAX_JSON) for path in args[:4]]
        result = verify_readback(*values, *args[4:])
    else:
        raise ProofError('COMMAND_ARGUMENTS_INVALID')
    print(canonical(result).decode())


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (ProofError, OSError, ValueError, TypeError, KeyError, AttributeError,
            subprocess.SubprocessError, zipfile.BadZipFile) as error:
        # Deliberately exclude paths, HTTP response bodies, environment or SSH material.
        print(json.dumps({'status': 'FAILED_CLOSED', 'error':
                         str(error) if isinstance(error, ProofError) else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
