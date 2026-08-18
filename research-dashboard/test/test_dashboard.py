import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

import server


class DashboardFixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="research-dashboard-")
        self.root = Path(self.temp.name)
        (self.root / "latest").mkdir(parents=True)
        (self.root / "forward" / "paper" / "status").mkdir(parents=True)
        (self.root / "forward" / "paper" / "state").mkdir(parents=True)
        now = 1_787_000_000_000
        (self.root / "latest" / "forward.json").write_text(json.dumps({
            "status": "complete",
            "cycleId": "cycle-1",
            "researchSha": "a" * 40,
            "generatedAt": now,
            "concurrency": 1,
            "taskCount": 2,
            "successCount": 2,
            "blockedDataCount": 0,
            "failedCount": 0,
            "results": [
                {"id": "paper-forward", "status": "success", "durationMs": 1000},
                {"id": "shadow-forward", "status": "success", "durationMs": 2000},
            ],
        }), encoding="utf-8")
        (self.root / "forward" / "paper" / "status" / "runtime-status.json").write_text(json.dumps({
            "status": "running",
            "scheduleActive": True,
            "allProvidersReady": True,
            "publicForwardEvidenceAccumulating": True,
            "paperTradeOutcomeAccumulating": True,
            "privateRequestCount": 0,
            "financialMutationCount": 0,
            "orderCount": 0,
            "liveTrading": False,
            "orderAuthority": False,
            "lanes": [{"market": "KR", "status": "ready"}, {"market": "US", "status": "ready"}],
        }), encoding="utf-8")
        (self.root / "forward" / "paper" / "state" / "recurring-paper-loop.json").write_text(json.dumps({
            "cycles": [{"id": 1}], "positions": [{"id": 1}], "settlements": [{"id": 1}, {"id": 2}],
        }), encoding="utf-8")
        (self.root / "forward" / "shadow-summary.json").write_text(json.dumps({"groups": {
            "rule0": {"total": 5, "settled": 3, "pending": 2, "predictionHealth": {"collapsed": False}, "metrics": {"macroF1": 0.51, "balancedAccuracy": 0.55}},
        }}), encoding="utf-8")
        (self.root / "forward" / "shadow-state.json").write_text(json.dumps({"bucket": {"records": [
            {"status": "settled"}, {"status": "settled"}, {"status": "pending"},
        ]}}), encoding="utf-8")

    def close(self):
        self.temp.cleanup()


class ResearchDashboardTests(unittest.TestCase):
    def setUp(self):
        self.fixture = DashboardFixture()

    def tearDown(self):
        self.fixture.close()

    def test_overview_exposes_summarized_read_only_evidence(self):
        overview = server.build_research_overview(self.fixture.root)
        self.assertTrue(overview["safety"]["readOnlyDashboard"])
        self.assertFalse(overview["safety"]["forbiddenAuthorityObserved"])
        self.assertEqual(overview["paper"]["ledger"]["settlementCount"], 2)
        self.assertEqual(overview["shadow"]["records"]["settledRecords"], 2)
        self.assertFalse(overview["shadow"]["groups"][0]["collapsed"])
        self.assertFalse(overview["profitability"]["proven"])

    def _running_server(self):
        public_root = Path(__file__).resolve().parents[1] / "public"
        httpd = server.create_server(host="127.0.0.1", port=0, state_root=self.fixture.root, public_root=public_root)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        return httpd, thread

    def test_dashboard_refuses_write_methods(self):
        httpd, thread = self._running_server()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=2)
            conn.request("POST", "/api/research/overview", body=b"{}")
            response = conn.getresponse()
            payload = json.loads(response.read())
            self.assertEqual(response.status, 405)
            self.assertEqual(payload["error"], "read_only_dashboard")
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

    def test_health_declares_zero_trading_authority(self):
        httpd, thread = self._running_server()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=2)
            conn.request("GET", "/api/health")
            response = conn.getresponse()
            payload = json.loads(response.read())
            self.assertEqual(response.status, 200)
            self.assertTrue(payload["readOnly"])
            self.assertFalse(payload["liveTrading"])
            self.assertFalse(payload["privateApi"])
            self.assertFalse(payload["orderAuthority"])
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
