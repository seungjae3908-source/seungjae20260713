"""Offline regressions for the actual read-only diagnostic; fixtures are not evidence."""
import hashlib
import importlib.util
import io
import json
import os
import socket
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / '.github/scripts/research-dashboard-v3-state-diagnostic.py'
SPEC = importlib.util.spec_from_file_location('research_v3_state_diagnostic', SCRIPT)
diag = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(diag)
MISSING = object()
NON_OBJECTS = (None, [], 'not-an-object', 1, True, 1.5)


def signed(value):
    body = dict(value)
    body.pop('reportDigest', None)
    canonical = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return {**body, 'reportDigest': hashlib.sha256(canonical.encode('utf-8')).hexdigest()}


def valid_summary(buy=10, sell=5):
    total = buy + sell
    return signed({
        'schemaVersion': 'public-forward-liquidity-v3-authoritative-independence-summary-v1',
        'producerSha': 'a' * 40,
        'upstreamIngestRunId': 123456789,
        'upstreamIngestArtifactId': 987654321,
        'upstreamIngestArtifactDigest': 'b' * 64,
        'sourceInventoryDigest': 'c' * 64,
        'independenceAuditDigest': 'd' * 64,
        'independentSplitSourceDigest': 'e' * 64,
        'v3IndependentSplitIndexDigest': 'f' * 64,
        'targetSlotIndex': 48,
        'genuineScheduledSlotN': total,
        'rawAcceptedN': 120,
        'effectiveIndependentN': total,
        'independentBuyN': buy,
        'independentSellN': sell,
        'frozenSplitCounts': {
            'TRAIN': total, 'TRAIN_BUY': buy, 'TRAIN_SELL': sell,
            'VALIDATION': 0, 'VALIDATION_BUY': 0, 'VALIDATION_SELL': 0,
            'OOS': 0, 'OOS_BUY': 0, 'OOS_SELL': 0,
        },
        'oosOutcomeCredit': 0,
        'calibrationArtifactProduced': False,
        'liquidityImpactStatus': 'BLOCKED_DATA',
        'fullCostReady': False,
        'evidenceComplete': 0,
        'executionAuthority': 'NONE',
        'frozenV3SplitIndexPresent': True,
        'v2SplitReceiptPresent': False,
    })


def overview(liquidity=MISSING):
    return {
        'schemaVersion': 'research-dashboard-overview-v1',
        'research': {} if liquidity is MISSING else {'liquidityIndependence': liquidity},
        'safety': {'readOnlyDashboard': True, 'liveTrading': False,
                   'privateApi': False, 'orderAuthority': False},
    }


class V3StateDiagnosticTest(unittest.TestCase):
    def setUp(self):
        # Fail if a test accidentally reaches a real socket, including loopback.
        for name in ('socket', 'create_connection'):
            guard = patch.object(socket, name, side_effect=AssertionError('network forbidden in diagnostic tests'))
            guard.start()
            self.addCleanup(guard.stop)

    def run_diagnostic(self, content=MISSING, *, directory=False, read_error=None,
                       endpoint=MISSING, endpoint_error=None, runtime='python3 server.py'):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            target = root / diag.RELATIVE_PATH
            if directory or content is not MISSING:
                target.parent.mkdir(parents=True, exist_ok=True)
                if directory:
                    target.mkdir()
                else:
                    target.write_text(content, encoding='utf-8')
            before = target.read_bytes() if target.is_file() else None
            if endpoint is MISSING:
                endpoint = overview({'present': True, 'status': 'PRESENT'})
            output = io.StringIO()
            with ExitStack() as stack:
                stack.enter_context(patch.dict(os.environ, {'RESEARCH_DIAG_MAIN_PID': '12345'}, clear=True))
                stack.enter_context(patch.object(diag, 'parse_proc_env', return_value={'RESEARCH_STATE_ROOT': str(root)}))
                stack.enter_context(patch.object(diag, 'runtime_command', return_value=runtime))
                response = io.BytesIO(json.dumps(endpoint).encode('utf-8'))
                request = stack.enter_context(patch.object(diag.urllib.request, 'urlopen',
                                                           return_value=response, side_effect=endpoint_error))
                if read_error is not None:
                    stack.enter_context(patch.object(Path, 'read_text', side_effect=read_error))
                stack.enter_context(redirect_stdout(output))
                diag.main()
                request.assert_called_once_with('http://127.0.0.1:18090/api/research/overview', timeout=8)
            result = json.loads(output.getvalue())
            self.assertEqual(result['stateRoot'], str(root))
            self.assertEqual(result['stateRootSource'], 'PROC_ENV')
            if before is not None:
                self.assertEqual(target.read_bytes(), before, 'diagnosis must not rewrite the input')
            elif content is MISSING and not directory:
                self.assertFalse(target.exists(), 'diagnosis must not create missing evidence')
            return result

    def assert_no_observations(self, result, classification, cause='RESEARCH_OVERVIEW_LIVE_V3_SUMMARY_INVALID'):
        self.assertEqual(result['fileClassification'], classification)
        self.assertEqual(result['rootCause'], cause)
        for flag in ('schemaValid', 'reportDigestValid', 'shapeValid', 'expectedTruthMatch'):
            self.assertIs(result[flag], False)
        self.assertEqual(result['observed'], {})
        for key in ('effectiveIndependentN', 'TRAIN', 'OOS', 'evidenceComplete', 'executionAuthority'):
            self.assertIsNone(result['observed'].get(key))

    def test_non_object_validator_returns_five_fields(self):
        for value in NON_OBJECTS:
            with self.subTest(value=value):
                self.assertEqual(diag.validate_v3(value), (False, False, False, {}, False))

    def test_valid_validator_preserves_all_five_fields(self):
        schema, digest, shape, observed, expected = diag.validate_v3(valid_summary())
        self.assertEqual((schema, digest, shape, expected), (True, True, True, True))
        self.assertEqual(observed['effectiveIndependentN'], 15)
        self.assertEqual(observed['OOS'], 0)
        self.assertEqual(observed['executionAuthority'], 'NONE')

    def test_invalid_object_validator_preserves_unknown_counts(self):
        schema, digest, shape, observed, expected = diag.validate_v3({})
        self.assertEqual((schema, digest, shape, expected), (False, False, False, False))
        self.assertIsNone(observed['effectiveIndependentN'])
        self.assertIsNone(observed['OOS'])

    def test_missing_file_emits_missing_not_an_unpacking_exception(self):
        result = self.run_diagnostic()
        self.assert_no_observations(result, 'MISSING', 'RESEARCH_OVERVIEW_LIVE_V3_SUMMARY_MISSING')
        self.assertIs(result['fileExists'], False)
        self.assertIsNone(result['fileSize'])

    def test_directory_emits_not_regular_file(self):
        self.assert_no_observations(self.run_diagnostic(directory=True), 'NOT_REGULAR_FILE')

    def test_malformed_and_empty_json_emit_parse_error(self):
        for content in ('{not-json', ''):
            with self.subTest(content=content):
                result = self.run_diagnostic(content)
                self.assert_no_observations(result, 'JSON_PARSE_ERROR')
                self.assertIs(result['fileReadable'], True)
                self.assertIs(result['jsonParseOk'], False)

    def test_non_object_json_emits_invalid_without_fabricated_counts(self):
        for value in NON_OBJECTS:
            with self.subTest(value=value):
                result = self.run_diagnostic(json.dumps(value))
                self.assert_no_observations(result, 'INVALID')
                self.assertIs(result['fileReadable'], True)
                self.assertIs(result['jsonParseOk'], True)

    def test_permission_denied_emits_structured_error(self):
        result = self.run_diagnostic('{}', read_error=PermissionError('fixture denied'))
        self.assert_no_observations(result, 'PERMISSION_DENIED')
        self.assertIs(result['fileReadable'], False)

    def test_other_read_error_emits_structured_error(self):
        result = self.run_diagnostic('{}', read_error=OSError('fixture read failure'))
        self.assert_no_observations(result, 'READ_ERROR')
        self.assertIs(result['fileReadable'], False)

    def test_valid_file_retains_expected_truth_and_safety(self):
        result = self.run_diagnostic(json.dumps(valid_summary()))
        self.assertEqual(result['fileClassification'], 'VALID_EXPECTED_TRUTH')
        self.assertEqual(result['rootCause'], 'NO_V3_STATE_ROOT_DEFECT_OBSERVED')
        self.assertIs(result['shapeValid'], True)
        self.assertIs(result['expectedTruthMatch'], True)
        self.assertEqual(result['observed']['effectiveIndependentN'], 15)
        self.assertEqual(result['observed']['evidenceComplete'], 0)
        self.assertIs(result['endpointReadOnly'], True)
        for key in ('endpointLiveTrading', 'endpointPrivateApi', 'endpointOrderAuthority'):
            self.assertIs(result[key], False)

    def test_missing_count_in_object_remains_unknown_and_invalid(self):
        value = valid_summary()
        value.pop('effectiveIndependentN')
        result = self.run_diagnostic(json.dumps(signed(value)))
        self.assertEqual(result['fileClassification'], 'INVALID')
        self.assertIsNone(result['observed']['effectiveIndependentN'])
        self.assertIs(result['shapeValid'], False)

    def test_tampered_digest_is_still_rejected(self):
        value = valid_summary()
        value['reportDigest'] = '0' * 64
        result = self.run_diagnostic(json.dumps(value))
        self.assertEqual(result['fileClassification'], 'INVALID')
        self.assertIs(result['reportDigestValid'], False)
        self.assertIs(result['shapeValid'], False)

    def test_authority_escalation_is_still_rejected(self):
        value = valid_summary()
        value['executionAuthority'] = 'LIVE'
        result = self.run_diagnostic(json.dumps(signed(value)))
        self.assertEqual(result['fileClassification'], 'INVALID')
        self.assertIs(result['shapeValid'], False)
        self.assertEqual(result['observed']['executionAuthority'], 'LIVE')

    def test_boolean_count_is_not_an_observed_zero(self):
        value = valid_summary()
        value['effectiveIndependentN'] = False
        result = self.run_diagnostic(json.dumps(signed(value)))
        self.assertEqual(result['fileClassification'], 'INVALID')
        self.assertIs(result['shapeValid'], False)

    def test_unexpected_but_valid_truth_is_not_replaced_by_expected_counts(self):
        result = self.run_diagnostic(json.dumps(valid_summary(buy=11)))
        self.assertEqual(result['fileClassification'], 'VALID_UNEXPECTED_TRUTH')
        self.assertEqual(result['rootCause'], 'RESEARCH_OVERVIEW_LIVE_V3_SUMMARY_STALE_OR_UNEXPECTED')
        self.assertEqual(result['observed']['effectiveIndependentN'], 16)
        self.assertIs(result['shapeValid'], True)
        self.assertIs(result['expectedTruthMatch'], False)

    def test_endpoint_failure_is_still_distinguished(self):
        result = self.run_diagnostic(json.dumps(valid_summary()), endpoint_error=TimeoutError('fixture timeout'))
        self.assertEqual(result['rootCause'], 'RESEARCH_OVERVIEW_ENDPOINT_READ_FAILED')
        self.assertEqual(result['endpointReadErrorClass'], 'TimeoutError')
        self.assertIsNone(result['endpointLiquidityPresent'])
        self.assertIsNone(result['endpointOrderAuthority'])

    def test_missing_endpoint_consumer_is_still_distinguished(self):
        cases = (
            ('python3 server.py', 'RESEARCH_DASHBOARD_PYTHON_RUNTIME_V3_CONSUMER_MISSING'),
            ('node server.mjs', 'RESEARCH_DASHBOARD_RUNTIME_V3_CONSUMER_MISSING'),
        )
        for runtime, cause in cases:
            with self.subTest(runtime=runtime):
                result = self.run_diagnostic(json.dumps(valid_summary()), endpoint=overview(), runtime=runtime)
                self.assertEqual(result['rootCause'], cause)
                self.assertIs(result['endpointLiquidityFieldPresent'], False)

    def test_rejected_endpoint_consumer_is_still_distinguished(self):
        result = self.run_diagnostic(json.dumps(valid_summary()),
                                     endpoint=overview({'present': False, 'status': 'MISSING'}))
        self.assertEqual(result['rootCause'], 'RESEARCH_DASHBOARD_RUNTIME_V3_CONSUMER_REJECTED')


if __name__ == '__main__':
    unittest.main()
