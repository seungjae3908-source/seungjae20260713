import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd(), path.basename(process.cwd()) === 'api-server' ? '..' : '.');
const read = (file) => readFile(path.join(root, file), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[forward-observer-runtime-contract] ${message}`);
};

const workflow = await read('.github/workflows/forward-recommendation-observer-cycle.yml');
const runtime = await read('api-server/src/services/forward-recommendation-observer-runtime.service.ts');
const runner = await read('api-server/src/scripts/run-forward-recommendation-observer-cycle.ts');
const tests = await read('api-server/src/services/forward-recommendation-observer-runtime.service.test.ts');
const observer = await read('api-server/src/services/forward-recommendation-observer.service.ts');

assert(/workflow_dispatch:/.test(workflow), 'runtime must require explicit workflow dispatch');
assert(/pull_request:/.test(workflow), 'PR must run static-only validation');
assert(!/^\s*schedule:/mu.test(workflow), 'automatic schedule activation is forbidden in this lane');
assert(workflow.includes("if: github.event_name == 'workflow_dispatch'"), 'live observation job must be dispatch-only');
assert(workflow.includes("if: github.event_name == 'pull_request'"), 'PR validation job must be static-only');
assert(workflow.includes('actions: read') && workflow.includes('contents: read'), 'workflow permissions must be read-only');
assert(!/environment:\s*(?:production|staging)/iu.test(workflow), 'Production/Staging environments are forbidden');
assert(!/secrets\./u.test(workflow), 'workflow must not consume repository/environment secrets');
assert(!/\bssh\b|\bpm2\b|deploy-production|run-staging|supabase\s+db/iu.test(workflow), 'deploy/SSH/DB mutation tooling is forbidden');
assert(workflow.includes('research_sha'), 'immutable research SHA input is required');
assert(workflow.includes('forward-recommendation-observer-state-${{ inputs.research_sha }}'), 'artifact chain must be SHA-scoped');
assert(workflow.includes('stateSha256') && workflow.includes('summarySha256'), 'predecessor artifact digests must be verified');
assert(workflow.includes('actions/download-artifact@v4') && workflow.includes('actions/upload-artifact@v4'), 'artifact-only chaining must be explicit');
assert(workflow.includes('No previous observer artifact') || workflow.includes('No predecessor observer artifact'), 'clean first-run state must be explicit');

for (const marker of [
  "executionAuthority: 'NONE'",
  'financialMutationAllowed: false',
  'liveOrderAllowed: false',
  'privateTradingApiAllowed: false',
  'profitabilityClaimAllowed: false',
  'publicDataOnly: true',
  'artifactOnly: true',
  "fullStrategyCoverage: false",
]) {
  assert(runtime.includes(marker), `runtime safety marker missing: ${marker}`);
}
assert(runtime.includes('latestCardEvidenceTimestamp'), 'runtime must derive data time from actual scanner evidence');
assert(runtime.includes('DATA_TIMESTAMP_FROM_MATCHED_EVIDENCE_REQUIRED'), 'missing evidence timestamp must fail closed');
assert(runtime.includes('futureOnlyBars'), 'settlement must filter pre-signal bars');
assert(runtime.includes('buildForwardObservationProfitCalibration'), 'runtime must use canonical calibration builder');
assert(observer.includes("source: FORWARD_OBSERVATION_SOURCE"), 'canonical observer source contract must remain in use');

for (const publicMarker of [
  "import * as yahoo from '../providers/yahoo'",
  "const UPBIT_BASE = 'https://api.upbit.com'",
  "const BITGET_BASE = 'https://api.bitget.com'",
  'CryptoPricePrecisionService.align',
  'StockSignalScannerService.scan',
  'CryptoSignalScannerService.scan',
  'withScannerCanonicalActions',
]) {
  assert(runner.includes(publicMarker), `public/canonical runtime marker missing: ${publicMarker}`);
}
for (const forbidden of [
  "../providers/toss",
  "../providers/kiwoom",
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'LIVE_TRADING_ENABLED=true',
  'REAL_ORDER_ENABLED=true',
  'PRIVATE_TRADING_API_ALLOWED=true',
  'deliverScannerTelegramAlerts',
]) {
  assert(!runner.includes(forbidden) && !workflow.includes(forbidden), `forbidden runtime dependency present: ${forbidden}`);
}
assert(runner.includes('withYahooPublicOnlyStockData'), 'stock scanner must be isolated behind Yahoo public-only adapter');
assert(runner.includes("'signal-intelligence-forward-observer-public-only'"), 'stock observer must select the existing scanner public-core guard');
assert(runner.includes('memberId: FORWARD_OBSERVER_PUBLIC_STOCK_MEMBER_ID'), 'stock scanner call must use the public-core member identity');
assert(runner.includes('getCandlesMeta(ticker: string, timeframe?: Timeframe)'), 'Yahoo adapter must cover the scanner getCandlesMeta seam');
assert(runner.includes('mutable.getCandlesMeta = async') && runner.includes("provider: 'yahoo'"), 'scanner candle metadata must stay on Yahoo public data');
assert(
  runner.includes("process.env.SIGNAL_INTELLIGENCE_PUBLIC_ONLY_UNIVERSE = 'true'"),
  'stock observer must enable the existing public-only universe capability filter',
);
assert(
  runner.includes('originalPublicOnlyUniverse')
    && runner.includes('delete process.env.SIGNAL_INTELLIGENCE_PUBLIC_ONLY_UNIVERSE')
    && runner.includes('process.env.SIGNAL_INTELLIGENCE_PUBLIC_ONLY_UNIVERSE = originalPublicOnlyUniverse'),
  'public-only universe env must be restored after the temporary stock adapter',
);
assert(
  runner.includes('finally')
    && runner.includes('originalCandles')
    && runner.includes('originalCandlesMeta')
    && runner.includes('originalQuote')
    && runner.includes('mutable.getCandlesMeta = originalCandlesMeta'),
  'temporary stock adapter must restore getCandles/getCandlesMeta/getQuote defaults',
);
assert(tests.includes('missing matched evidence timestamps are blocked'), 'missing evidence timestamp regression test required');
assert(tests.includes('ignores pre-signal bars'), 'future-only settlement regression test required');
assert(tests.includes('idempotent'), 'idempotency regression test required');

console.log('[forward-observer-runtime-contract] static contract passed');
