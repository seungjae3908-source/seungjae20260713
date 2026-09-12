#!/usr/bin/env python3
"""Offline fixtures only. These tests grant no research/economic sample credit."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import warnings
import zipfile

SPEC = importlib.util.spec_from_file_location('proof', Path(__file__).with_name('v3_publication_proof.py'))
p = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p)


def commit(repo, message):
    subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True, capture_output=True)
    subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Offline Test',
                    '-c', 'user.email=offline@example.invalid', 'commit', '-qm', message],
                   check=True, capture_output=True)
    return p.git(repo, 'rev-parse', 'HEAD')


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.repo = self.base / 'control'
        self.repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        pins = {}
        for index, name in enumerate(p.PINNED_BLOBS):
            data = f'// isolated fixture module {index}\n'.encode()
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            pins[name] = p.blob(data)
        self.pins = patch.object(p, 'PINNED_BLOBS', pins)
        self.pins.start()
        self.addCleanup(self.pins.stop)
        self.runtime_sha = commit(self.repo, 'reviewed fixture code')
        self.research = self.base / 'research'
        self.release = self.research / 'releases' / self.runtime_sha
        self.release.parent.mkdir(parents=True)
        shutil.copytree(self.repo, self.release)
        (self.research / 'current').symlink_to(self.release)
        self.state = self.base / 'state'
        self.state.mkdir()
        (self.repo / 'unrelated.txt').write_text('unrelated main move\n')
        self.control_sha = commit(self.repo, 'unrelated main change')
        self.proof = p.build_code_proof(self.repo, self.control_sha)

    def runtime(self):
        return p.verify_runtime(self.proof, self.research, self.state)

    def test_equivalent_older_release_without_any_write(self):
        before = sorted((str(x.relative_to(self.release)), x.read_bytes())
                        for x in self.release.rglob('*') if x.is_file())
        result = self.runtime()
        self.assertNotEqual(self.control_sha, self.runtime_sha)
        self.assertTrue(result['codeEquivalent'])
        self.assertEqual(p.check_ancestor(self.repo, self.control_sha, result), self.runtime_sha)
        self.assertEqual(before, sorted((str(x.relative_to(self.release)), x.read_bytes())
                         for x in self.release.rglob('*') if x.is_file()))
        self.assertEqual(list(self.state.iterdir()), [])

    def test_exact_release_also_passes(self):
        self.assertEqual(p.build_code_proof(self.release, self.runtime_sha)['files'], self.proof['files'])

    def test_control_head_mismatch(self):
        with self.assertRaisesRegex(p.ProofError, 'HEAD_MISMATCH'):
            p.build_code_proof(self.repo, self.runtime_sha)

    def test_dirty_runtime_same_git_head_rejected(self):
        (self.release / next(iter(p.PINNED_BLOBS))).write_text('changed\n')
        with self.assertRaisesRegex(p.ProofError, 'DIRTY_PUBLISHER_CODE'):
            self.runtime()

    def test_changed_current_code_requires_allowlist_review(self):
        (self.repo / next(iter(p.PINNED_BLOBS))).write_text('import "new-dependency";\n')
        sha = commit(self.repo, 'new unreviewed closure')
        with self.assertRaisesRegex(p.ProofError, 'UNREVIEWED_PUBLISHER_CODE'):
            p.build_code_proof(self.repo, sha)

    def test_runtime_path_symlink_rejected(self):
        target = self.release / next(iter(p.PINNED_BLOBS))
        outside = self.base / 'outside'
        outside.write_bytes(target.read_bytes())
        target.unlink()
        target.symlink_to(outside)
        with self.assertRaisesRegex(p.ProofError, 'SYMLINK_REJECTED'):
            self.runtime()

    def test_state_root_symlink_rejected(self):
        link = self.base / 'state-link'
        link.symlink_to(self.state, target_is_directory=True)
        with self.assertRaisesRegex(p.ProofError, 'STATE_ROOT_UNSAFE'):
            p.verify_runtime(self.proof, self.research, link)

    def test_release_path_escape_rejected(self):
        current = self.research / 'current'
        current.unlink()
        current.symlink_to(self.repo)
        with self.assertRaisesRegex(p.ProofError, 'CURRENT_RELEASE_UNSAFE'):
            self.runtime()

    def test_runtime_checkout_mismatch_rejected(self):
        (self.release / 'new').write_text('unexpected runtime change')
        commit(self.release, 'runtime advanced')
        with self.assertRaisesRegex(p.ProofError, 'HEAD_MISMATCH'):
            self.runtime()

    def test_unrelated_runtime_commit_rejected(self):
        subprocess.run(['git', '-C', str(self.repo), 'checkout', '-q', '-b', 'divergent', self.runtime_sha], check=True)
        (self.repo / 'other').write_text('divergent')
        divergent = commit(self.repo, 'different lineage')
        subprocess.run(['git', '-C', str(self.repo), 'checkout', '-q', self.control_sha], check=True)
        result = self.runtime()
        result['runtimeSha'] = divergent
        with self.assertRaisesRegex(p.ProofError, 'RUNTIME_NOT_APPROVED_ANCESTOR'):
            p.check_ancestor(self.repo, self.control_sha, result)

    def test_manifest_round_trip_and_closure_lock(self):
        encoded = base64.b64encode(p.canonical(self.proof)).decode()
        self.assertEqual(p.decode_proof(encoded), self.proof)
        for bad in ({}, {'new-module': {}}, {**self.proof['files'], 'extra': {}}):
            value = {**self.proof, 'files': bad}
            with self.assertRaisesRegex(p.ProofError, 'CODE_CLOSURE_MISMATCH'):
                p.decode_proof(base64.b64encode(p.canonical(value)).decode())

    def test_sha256_mismatch_rejected_even_with_matching_git_blob(self):
        self.proof['files'][next(iter(p.PINNED_BLOBS))]['sha256'] = 'a' * 64
        with self.assertRaisesRegex(p.ProofError, 'RUNTIME_CODE_NOT_EQUIVALENT'):
            self.runtime()


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.archive = self.root / 'source.zip'
        self.output = self.root / 'summary.json'

    def extract(self):
        return p.extract_summary(self.archive, 'sha256:' + p.digest(self.archive.read_bytes()), self.output)

    def test_extract_one_summary_never_other_paths(self):
        with zipfile.ZipFile(self.archive, 'w') as z:
            z.writestr(p.SUMMARY_NAME, '{"fixture":true}')
            z.writestr('../escaped.txt', 'not extracted')
        self.extract()
        self.assertEqual(self.output.read_text(), '{"fixture":true}')
        self.assertFalse((self.root.parent / 'escaped.txt').exists())
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)

    def test_digest_mismatch_has_no_output(self):
        with zipfile.ZipFile(self.archive, 'w') as z:
            z.writestr(p.SUMMARY_NAME, '{}')
        with self.assertRaisesRegex(p.ProofError, 'ARTIFACT_DIGEST_MISMATCH'):
            p.extract_summary(self.archive, 'sha256:' + '0' * 64, self.output)
        self.assertFalse(self.output.exists())

    def test_duplicate_summary_rejected(self):
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(self.archive, 'w') as z:
                z.writestr(p.SUMMARY_NAME, '{}')
                z.writestr(p.SUMMARY_NAME, '{}')
        with self.assertRaisesRegex(p.ProofError, 'SUMMARY_CARDINALITY_INVALID'):
            self.extract()

    def test_symlink_summary_rejected(self):
        entry = zipfile.ZipInfo(p.SUMMARY_NAME)
        entry.create_system = 3
        entry.external_attr = 0o120777 << 16
        with zipfile.ZipFile(self.archive, 'w') as z:
            z.writestr(entry, '{}')
        with self.assertRaisesRegex(p.ProofError, 'SUMMARY_ENTRY_UNSAFE'):
            self.extract()

    def test_oversized_member_rejected(self):
        with zipfile.ZipFile(self.archive, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr(p.SUMMARY_NAME, b' ' * (p.MAX_JSON + 1))
        with self.assertRaisesRegex(p.ProofError, 'SUMMARY_ENTRY_UNSAFE'):
            self.extract()

    def test_existing_destination_not_overwritten(self):
        with zipfile.ZipFile(self.archive, 'w') as z:
            z.writestr(p.SUMMARY_NAME, '{}')
        self.output.write_text('preserve')
        with self.assertRaises(FileExistsError):
            self.extract()
        self.assertEqual(self.output.read_text(), 'preserve')

    def test_ambiguous_and_nonfinite_json_rejected(self):
        for text in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'[]'):
            with self.subTest(text=text), self.assertRaises(p.ProofError):
                p.parse_json(text)


def fixture(n=31, buy=17):
    control, runtime = 'a' * 40, 'b' * 40
    expected = {key: '1' * 64 for key in p.OVERVIEW_FIELDS}
    expected.update(schemaVersion='public-forward-liquidity-v3-authoritative-independence-summary-v1',
                    producerSha='c' * 40, upstreamIngestRunId=600001,
                    upstreamIngestArtifactId=600002, targetSlotIndex=94,
                    genuineScheduledSlotN=n, rawAcceptedN=n * 3,
                    effectiveIndependentN=n, independentBuyN=buy, independentSellN=n - buy,
                    frozenSplitCounts={'TRAIN': n, 'TRAIN_BUY': buy, 'TRAIN_SELL': n - buy,
                                       'VALIDATION': 0, 'VALIDATION_BUY': 0, 'VALIDATION_SELL': 0,
                                       'OOS': 0, 'OOS_BUY': 0, 'OOS_SELL': 0},
                    oosOutcomeCredit=0, calibrationArtifactProduced=False,
                    liquidityImpactStatus='BLOCKED_DATA', fullCostReady=False,
                    evidenceComplete=0, executionAuthority='NONE',
                    frozenV3SplitIndexPresent=True, v2SplitReceiptPresent=False)
    expected.pop('reportDigest')
    expected['reportDigest'] = p.digest(p.canonical(expected))
    source = dict(workflowRunId=600003, artifactId=600004,
                  artifactName='public-forward-liquidity-v3-authoritative-independence-slot-94-600003-1',
                  artifactDigest='sha256:' + 'd' * 64, headSha='c' * 40, runAttempt=1,
                  workflowName='Public Forward Liquidity V3 Independence Consume',
                  event='workflow_run', branch='main', conclusion='success')
    publication = {key: expected[key] for key in ('reportDigest', 'targetSlotIndex', 'effectiveIndependentN',
                                                 'independentBuyN', 'independentSellN', 'frozenSplitCounts',
                                                 'oosOutcomeCredit', 'calibrationArtifactProduced',
                                                 'fullCostReady', 'evidenceComplete', 'executionAuthority')}
    publication.update(schemaVersion='research-v3-independence-production-publication-result-v1',
                       status='PUBLISHED', codeSha=runtime, stateRoot=str(p.STATE_ROOT),
                       targetPath=str(p.STATE_ROOT / p.SUMMARY_PATH), fileDigest='e' * 64,
                       liveTrading=False, privateApi=False, realOrders=0,
                       source={key: str(source[key]) for key in ('workflowRunId', 'artifactId', 'artifactName', 'artifactDigest')})
    observed = dict(schemaVersion='v3-publication-snapshot-v1', fileDigest='e' * 64,
                    runtime=dict(controlSha=control, runtimeSha=runtime, codeEquivalent=True, stateRoot=str(p.STATE_ROOT)),
                    summary=copy.deepcopy(expected),
                    overview=dict(schemaVersion='research-dashboard-overview-v1',
                                  safety=dict(readOnlyDashboard=True, liveTrading=False, privateApi=False,
                                              orderAuthority=False, forbiddenAuthorityObserved=False),
                                  profitability=dict(proven=False),
                                  research=dict(liquidityIndependence=dict(present=True, status='PRESENT',
                                                **{key: copy.deepcopy(expected[key]) for key in p.OVERVIEW_FIELDS}))))
    return [expected, source, publication, observed, control, runtime]


class ReadbackTests(unittest.TestCase):
    def test_source_derived_counts_not_a_new_hardcoded_snapshot(self):
        for n, buy in ((1, 1), (15, 10), (31, 17), (32, 18), (70, 20)):
            with self.subTest(n=n):
                proof = p.verify_readback(*fixture(n, buy))
                self.assertEqual(proof['effectiveIndependentN'], n)
                self.assertEqual(proof['independentBuyN'], buy)
                self.assertEqual(proof['evidenceCredit'], 0)

    def test_each_missing_overview_field_fails(self):
        for field in p.OVERVIEW_FIELDS:
            with self.subTest(field=field):
                args = fixture()
                del args[3]['overview']['research']['liquidityIndependence'][field]
                with self.assertRaises(p.ProofError):
                    p.verify_readback(*args)

    def test_matching_total_but_wrong_buy_sell_fails(self):
        args = fixture()
        li = args[3]['overview']['research']['liquidityIndependence']
        li.update(independentBuyN=16, independentSellN=15)
        with self.assertRaisesRegex(p.ProofError, 'OVERVIEW_SOURCE_MISMATCH'):
            p.verify_readback(*args)

    def test_wrong_source_ids_digests_and_missing_vs_zero_fail(self):
        for field, value in (('producerSha', 'd' * 40), ('reportDigest', '0' * 64),
                             ('targetSlotIndex', 95), ('effectiveIndependentN', None),
                             ('oosOutcomeCredit', False), ('fullCostReady', 0)):
            with self.subTest(field=field):
                args = fixture()
                args[3]['overview']['research']['liquidityIndependence'][field] = value
                with self.assertRaises(p.ProofError):
                    p.verify_readback(*args)

    def test_wrong_archive_binding_and_wrong_receipt_file_digest_fail(self):
        for field in ('artifactId', 'artifactName', 'artifactDigest', 'workflowRunId'):
            args = fixture()
            args[2]['source'][field] = 'different'
            with self.subTest(field=field), self.assertRaises(p.ProofError):
                p.verify_readback(*args)
        args = fixture()
        args[2]['fileDigest'] = '0' * 64
        with self.assertRaisesRegex(p.ProofError, 'PUBLICATION_FILE_DIGEST_MISMATCH'):
            p.verify_readback(*args)

    def test_forged_summary_digest_and_stale_state_fail(self):
        args = fixture()
        args[0]['reportDigest'] = 'f' * 64
        with self.assertRaisesRegex(p.ProofError, 'SOURCE_REPORT_DIGEST_INVALID'):
            p.verify_readback(*args)
        args = fixture()
        args[3]['summary']['targetSlotIndex'] = 90
        with self.assertRaisesRegex(p.ProofError, 'STATE_SOURCE_MISMATCH'):
            p.verify_readback(*args)

    def test_safety_and_runtime_mismatch_fail(self):
        for field in ('liveTrading', 'privateApi', 'orderAuthority', 'forbiddenAuthorityObserved'):
            args = fixture()
            args[3]['overview']['safety'][field] = True
            with self.subTest(field=field), self.assertRaisesRegex(p.ProofError, 'OVERVIEW_SAFETY_INVALID'):
                p.verify_readback(*args)
        for field in ('controlSha', 'runtimeSha'):
            args = fixture()
            args[3]['runtime'][field] = 'f' * 40
            with self.assertRaisesRegex(p.ProofError, 'READBACK_RUNTIME_MISMATCH'):
                p.verify_readback(*args)

    def test_publication_failure_or_authority_escalation_fails(self):
        for field, value in (('status', 'FAILED'), ('realOrders', 1), ('evidenceComplete', 1),
                             ('liveTrading', True), ('executionAuthority', 'TRADE')):
            args = fixture()
            args[2][field] = value
            with self.subTest(field=field), self.assertRaises(p.ProofError):
                p.verify_readback(*args)

    def test_readback_state_race_fails_without_retry(self):
        runtime = {'runtimeSha': 'b' * 40}
        response = MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = b'{}'
        opener = MagicMock()
        opener.open.return_value = response
        with patch.object(p, 'verify_runtime', return_value=runtime), \
             patch.object(p, 'read_plain', side_effect=[b'{"a":1}', b'{"a":2}']), \
             patch.object(p.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(p.ProofError, 'STATE_CHANGED_DURING_READBACK'):
                p.snapshot({}, 'b' * 40)
            self.assertEqual(opener.open.call_count, 1)

    def test_redirects_cannot_leave_loopback_endpoint(self):
        with self.assertRaisesRegex(p.ProofError, 'OVERVIEW_REDIRECT_REJECTED'):
            p.NoRedirect().redirect_request(None, None, 302, None, None, 'https://outside.invalid')

    def test_malformed_nested_containers_fail_closed(self):
        for section in ('runtime', 'overview'):
            for value in (None, [], 'invalid'):
                args = list(fixture())
                args[3][section] = value
                with self.subTest(section=section, value=value), self.assertRaises(p.ProofError):
                    p.verify_readback(*args)
        for section in ('safety', 'profitability', 'research'):
            args = list(fixture())
            args[3]['overview'][section] = None
            with self.subTest(section=section), self.assertRaises(p.ProofError):
                p.verify_readback(*args)
        args = list(fixture())
        args[2]['source'] = None
        with self.assertRaises(p.ProofError):
            p.verify_readback(*args)


class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = (Path(__file__).resolve().parents[1] / 'workflows' /
                        'research-v3-independence-production-publication.yml').read_text()

    def test_original_authorization_gate_is_preserved(self):
        section = self.workflow[self.workflow.index('  authorize:\n'):self.workflow.index('\n  publish:\n')]
        self.assertEqual(p.digest(section.encode()), '2d39d6afcbf7a6003f11426169271668b75405a24d630c347e6e5084a5b876ba')

    def test_no_new_automatic_trigger_or_publication_on_pr(self):
        header = self.workflow.split('permissions:', 1)[0]
        self.assertNotIn('  schedule:', header)
        self.assertNotIn('  workflow_run:', header)
        self.assertNotIn('  workflow_dispatch:', header)
        self.assertIn('    needs: authorize', self.workflow)
        self.assertIn("github.event_name == 'issue_comment'", self.workflow)
        self.assertIn('  cancel-in-progress: false', self.workflow)

    def test_code_archive_ancestry_and_dynamic_readback_are_in_execution_path(self):
        for token in ('extract-summary', 'code-proof', 'runtime-proof', 'check-ancestor',
                      'snapshot $proof_q $runtime_q', 'verify-readback',
                      'sha256sum --check --status', '--expected-code-sha "$RUNTIME_SHA"',
                      'v3-publication-readback-proof.json', 'source_bound_readback'):
            self.assertIn(token, self.workflow)
        self.assertLess(self.workflow.index('check-ancestor'),
                        self.workflow.index('      - name: Stage public evidence inputs on server'))
        self.assertNotIn('effectiveIndependentN !== 15', self.workflow)
        self.assertNotIn('effectiveIndependentN !== 31', self.workflow)

    def test_no_deploy_restart_symlink_or_second_publisher(self):
        runtime = self.workflow.split('  authorize:', 1)[1]
        for token in ('systemctl restart', 'systemctl start', 'systemctl enable',
                      'pm2 restart', 'git checkout', 'ln -s', 'git reset', 'git push'):
            self.assertNotIn(token, runtime)
        self.assertIn('runuser -u investment-research', runtime)
        self.assertIn('LIVE_TRADING=false', runtime)
        self.assertIn('PRIVATE_TRADING_API_ALLOWED=false', runtime)
        self.assertIn('production_state_mutation: UNKNOWN_AFTER_FAILURE', runtime)
        self.assertIn('retry_without_evidence: false', runtime)

    def test_staging_cleanup_record_precedes_first_copy(self):
        stage = self.workflow.split('      - name: Stage public evidence inputs on server', 1)[1]
        stage = stage.split('      - name: Publish through', 1)[0]
        self.assertLess(stage.index('remote_dir=$remote_dir'), stage.index('scp -q'))
        self.assertIn('research-v3-independence-publish\\.[A-Za-z0-9]{6}', stage)


if __name__ == '__main__':
    unittest.main(verbosity=2)
