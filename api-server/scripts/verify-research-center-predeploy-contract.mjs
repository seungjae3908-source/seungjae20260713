import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd(), path.basename(process.cwd()) === 'api-server' ? '..' : '.');
const read = (file) => readFile(path.join(root, file), 'utf8');
const fail = (message) => { throw new Error('[research-center-predeploy] ' + message); };
const requireText = (text, needle, label) => {
  if (!text.includes(needle)) fail(label + ' missing: ' + needle);
};
const forbidText = (text, needle, label) => {
  if (text.includes(needle)) fail(label + ' forbidden: ' + needle);
};
const requireRegex = (text, regex, label) => {
  if (!regex.test(text)) fail(label + ' did not match ' + regex);
};
const extractFrozenArray = (text, name) => {
  const markers = [
    `export const ${name} = Object.freeze([`,
    `const ${name} = Object.freeze([`,
  ];
  const marker = markers.find((candidate) => text.includes(candidate));
  if (!marker) fail(name + ' array start not found');
  const start = text.indexOf(marker) + marker.length;
  const ends = [
    text.indexOf('] as const);', start),
    text.indexOf(']);', start),
  ].filter((value) => value >= 0);
  const end = ends.length ? Math.min(...ends) : -1;
  if (end < 0) fail(name + ' array end not found');
  return [...text.slice(start, end).matchAll(/['"]([^'"]+)['"]/gu)].map((row) => row[1]);
};
const assertSameSet = (actual, expected, label) => {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(label + ' mismatch: actual=' + JSON.stringify(left) + ' expected=' + JSON.stringify(right));
  }
};

const files = Object.fromEntries(await Promise.all([
  'stock-analyzer/src/App.tsx',
  'stock-analyzer/src/lib/app-navigation.ts',
  'stock-analyzer/src/lib/research-center.ts',
  'stock-analyzer/src/lib/research-center-product.ts',
  'stock-analyzer/src/lib/research-journal-binding.ts',
  'stock-analyzer/src/lib/strategy-promotion.ts',
  'stock-analyzer/src/components/research-video-source-panel.tsx',
  'api-server/src/routes/index.ts',
  'api-server/src/routes/admin.ts',
  'api-server/src/routes/video-research-evidence.ts',
  'api-server/src/routes/video-research-source-evidence.ts',
  'api-server/src/routes/research-workspace.ts',
  'api-server/src/routes/strategy-promotion.ts',
  'api-server/src/routes/paper-journal.ts',
  'api-server/src/services/research-center-readonly-contract.service.ts',
  'market-prediction-lab/src/frozen-candidate-performance-reader-v1.js',
  '.github/workflows/fast-profitability-v1-activation.yml',
  '.github/workflows/fast-profitability-v1-collector.yml',
  '.github/workflows/fast-profitability-v1-preactivation-watch.yml',
  '.github/workflows/prediction-lab-52d-validation.yml',
  '.github/workflows/prediction-lab-canonical-shadow-cycle.yml',
  'market-prediction-lab/tests/canonical-shadow-runtime-activation-v1.test.js',
].map(async (file) => [file, await read(file)])));

const app = files['stock-analyzer/src/App.tsx'];
const nav = files['stock-analyzer/src/lib/app-navigation.ts'];
const researchClient = files['stock-analyzer/src/lib/research-center.ts'];
const product = files['stock-analyzer/src/lib/research-center-product.ts'];
const journalClient = files['stock-analyzer/src/lib/research-journal-binding.ts'];
const promotionClient = files['stock-analyzer/src/lib/strategy-promotion.ts'];
const videoClient = files['stock-analyzer/src/components/research-video-source-panel.tsx'];
const routeIndex = files['api-server/src/routes/index.ts'];
const admin = files['api-server/src/routes/admin.ts'];
const videoRouter = files['api-server/src/routes/video-research-evidence.ts'];
const videoSource = files['api-server/src/routes/video-research-source-evidence.ts'];
const workspace = files['api-server/src/routes/research-workspace.ts'];
const promotionRoute = files['api-server/src/routes/strategy-promotion.ts'];
const paperRoute = files['api-server/src/routes/paper-journal.ts'];
const overviewContract = files['api-server/src/services/research-center-readonly-contract.service.ts'];
const candidateReader = files['market-prediction-lab/src/frozen-candidate-performance-reader-v1.js'];

requireText(app, "function ResearchCenterAccess() { return gated('canManageMembers', <ResearchCenterPage />); }", 'frontend Research Center capability');
requireText(app, '<Route path="/research-center" component={ResearchCenterAccess} />', 'frontend Research Center route');
requireRegex(nav, /id:\s*'research-center'[\s\S]{0,220}capability:\s*'canManageMembers'/u, 'navigation Research Center capability');
requireText(researchClient, "authorizedFetch('/api/admin/research/overview'", 'overview client endpoint');

requireText(admin, 'router.use(requireAuthenticated, requireAdmin);', 'admin auth boundary');
requireText(admin, "router.get('/research/overview'", 'admin Research overview route');
requireText(admin, "const RESEARCH_OVERVIEW_URL = 'http://127.0.0.1:18090/api/research/overview';", 'Research Dashboard loopback');
requireText(admin, 'sanitizeResearchCenterOverview(upstreamPayload)', 'overview sanitizer');
requireRegex(admin, /RESEARCH_OVERVIEW_TIMEOUT_MS\s*=\s*10_000/u, 'bounded overview timeout');
requireText(routeIndex, "router.use('/admin', adminRouter);", 'admin router mount');

requireText(videoClient, "authorizedFetch('/api/research/video/evidence'", 'video client endpoint');
requireText(routeIndex, "router.use('/research/video/evidence', requireCapability('canAccessBasicInfo'), videoResearchEvidenceRouter);", 'video API capability mount');
requireText(videoRouter, "router.use('/workspace', workspaceRouter);", 'video workspace child mount');
requireText(videoRouter, "router.use('/', sourceEvidenceRouter);", 'video source child mount');
requireText(videoSource, "router.get('/', async (_req, res) => {", 'video source GET-only route');
requireText(videoSource, "fetchImpl('http://127.0.0.1:18090/api/research/video/evidence'", 'durable video dashboard readback');
requireText(videoSource, 'snapshotBound', 'video automation lineage binding');
requireText(videoSource, 'VIDEO_RUNTIME_MAX_AGE_MS', 'video runtime bounded freshness');
requireText(videoSource, 'VIDEO_RESEARCH_SNAPSHOT_STALE', 'video stale snapshot fail-closed state');
requireText(videoClient, 'snapshotBound', 'browser video lineage parser');
requireText(videoClient, '현재 snapshot과 lineage 미결합', 'browser stale automation fail-closed state');
forbidText(videoSource, "router.post('/',", 'video source write route');
forbidText(videoSource, "router.put('/',", 'video source write route');
forbidText(videoSource, "router.delete('/',", 'video source write route');
requireText(workspace, "router.use(requireAuthenticated, requireCapability('canManageMembers'));", 'workspace admin capability');
requireText(workspace, "router.all('/providers'", 'workspace provider readback');
requireText(workspace, "router.all('/worker'", 'workspace worker readback');
requireText(workspace, "router.all('/orchestrator'", 'workspace orchestrator readback');
requireText(workspace, "router.all('/one-shot-review'", 'workspace one-shot readback');

requireText(routeIndex, "router.use('/strategy-promotion', requireCapability('canAccessBacktests'));", 'strategy promotion capability mount');
requireText(routeIndex, "router.use('/', strategyPromotionRouter);", 'strategy promotion router mount');
requireText(promotionClient, "authorizedFetch('/api/strategy-promotion'", 'strategy promotion client endpoint');
requireText(promotionClient, "authorizedFetch('/api/strategy-promotion/research-bridge'", 'research bridge client endpoint');
requireText(promotionClient, "authorizedFetch('/api/strategy-promotion/research-adoption-review'", 'adoption review client endpoint');
requireText(promotionRoute, "router.get('/strategy-promotion/research-bridge', requireAdmin", 'research bridge admin boundary');
requireText(promotionRoute, "router.get('/strategy-promotion/research-adoption-review', requireAdmin", 'adoption review admin boundary');
requireText(promotionClient, "executionAuthority !== 'NONE'", 'promotion authority parser');
requireText(promotionClient, 'automaticAdoptionAllowed !== false', 'promotion automatic-adoption lock');
requireText(promotionClient, 'liveTradingAllowed !== false', 'promotion live-trading lock');

requireText(routeIndex, "subpath === '/analytics'", 'paper journal analytics capability split');
requireText(routeIndex, "return requireCapability('canAccessTradingAnalytics')(req, res, next);", 'paper journal analytics capability');
requireText(routeIndex, "subpath.startsWith('/ai-review/')", 'paper journal AI review capability split');
requireText(routeIndex, "return requireCapability('canAccessAiTradingReview')(req, res, next);", 'paper journal AI review capability');
requireText(routeIndex, "return requireCapability('canAccessJournalSync')(req, res, next);", 'paper journal mutation capability fallback');
requireText(routeIndex, "router.use('/', paperJournalRouter);", 'paper journal router mount');
requireText(journalClient, "authorizedFetch('/api/paper-journal/unified-ledger?range=ALL'", 'journal client endpoint');
requireText(journalClient, "summary.source !== 'APP_AUTO_JOURNAL'", 'live feedback source validation');
requireText(journalClient, 'summary.researchMutationAllowed !== false', 'live feedback Research mutation lock');
requireText(journalClient, 'summary.promotionAuthority !== false', 'live feedback promotion lock');
requireText(journalClient, "summary.executionAuthority !== 'NONE'", 'live feedback execution authority lock');
requireText(journalClient, 'summary.profitabilityCredit !== 0', 'live feedback zero profitability credit');
requireText(paperRoute, "router.get('/paper-journal/unified-ledger'", 'unified journal API');
requireText(paperRoute, 'readCanonicalResearchOwnerStateForJournalBinding', 'journal research owner readback');
requireText(paperRoute, 'bindCanonicalResearchToUnifiedJournal', 'journal canonical binding');
requireText(paperRoute, 'buildLiveAutoResearchFeedback', 'live auto Research feedback readback');

const expectedCostKeys = [
  'commission', 'tax', 'spread', 'slippage',
  'funding', 'latency', 'liquidityImpact', 'partialFillImpact',
];
assertSameSet(extractFrozenArray(product, 'FULL_COST_KEYS'), expectedCostKeys, 'frontend Full Cost 8');
assertSameSet(extractFrozenArray(overviewContract, 'FULL_COST_KEYS'), expectedCostKeys, 'overview sanitizer Full Cost 8');
assertSameSet(extractFrozenArray(candidateReader, 'COST_KEYS'), expectedCostKeys, 'candidate reader Full Cost 8');
requireText(journalClient, 'fullCostComponentCount === 8', 'journal Full Cost 8 binding');
requireText(product, "row.state === 'measured' || row.state === 'modeled' || row.state === 'not-applicable'", 'frontend Full Cost readiness');
requireText(overviewContract, "FULL_COST_READY: false", 'overview current fail-closed profitability boundary');
requireText(candidateReader, 'PROFITABILITY_PROVEN: false', 'candidate current fail-closed profitability boundary');

for (const file of [
  '.github/workflows/fast-profitability-v1-activation.yml',
  '.github/workflows/fast-profitability-v1-collector.yml',
  '.github/workflows/fast-profitability-v1-preactivation-watch.yml',
]) {
  const text = files[file];
  requireText(text, "const RECEIPT_MARKER = '[FAST_PROFITABILITY_V1_ACTIVATED]';", file + ' canonical Fast receipt');
  requireText(text, "fields.get('activation_run_id')", file + ' exact activation run binding');
  requireText(text, 'listWorkflowRunArtifacts', file + ' exact artifact binding');
  forbidText(text, 'FAST_ACTIVATION_DISCOVERY_WINDOW_EXHAUSTED', file + ' noisy run-history failure');
}

const shadowWorkflow = files['.github/workflows/prediction-lab-canonical-shadow-cycle.yml'];
const shadowTest = files['market-prediction-lab/tests/canonical-shadow-runtime-activation-v1.test.js'];
requireText(shadowWorkflow, 'successful_publisher_runs=', 'Shadow authoritative Publisher history index');
requireText(shadowWorkflow, 'A receipt artifact is authoritative history only when its owning Publisher run succeeded.', 'Shadow authoritative receipt rule');
requireText(shadowWorkflow, 'Authoritative successful Publisher receipt history exists but no valid predecessor is usable; fail closed instead of bootstrap recovery', 'Shadow authoritative-history fail-closed guard');
requireText(shadowWorkflow, 'recovery_owner="${REPOSITORY%%/*}"', 'Shadow recovery owner binding');
requireText(shadowWorkflow, 'recovery_expected="/approve-canonical-shadow-recovery $TARGET_SHA"', 'Shadow exact recovery command');
requireText(shadowWorkflow, 'jq -sr --arg owner "$recovery_owner" --arg expected "$recovery_expected"', 'Shadow streamed recovery approval parser');
forbidText(shadowWorkflow, 'comments_json=', 'Shadow buffered Hub history');
forbidText(shadowWorkflow, '--paginate --slurp', 'Shadow slurped Hub history');
requireText(shadowTest, 'authoritative', 'Shadow authoritative history regression coverage');
requireText(shadowTest, 'canonical predecessor discovery must paginate successful publisher history', 'Shadow successful Publisher pagination regression coverage');
requireText(shadowTest, 'recovery approval pagination must stream rather than materialize malformed slurped JSON', 'Shadow streamed recovery regression coverage');

const multiMarket = files['.github/workflows/prediction-lab-52d-validation.yml'];
requireText(multiMarket, 'Record explicit research hold when required temporal evidence is incomplete', 'Multi-Market temporal hold');
requireText(multiMarket, 'RESEARCH_HOLD_TEMPORAL_EVIDENCE', 'Multi-Market temporal hold classification');
requireText(multiMarket, 'MISSING_TEMPORAL_REQUIRED_FEATURE_EVIDENCE:', 'Multi-Market temporal evidence blocker');
requireText(multiMarket, 'prediction-lab-research-hold-state-v1', 'Multi-Market hold aging state');
requireText(multiMarket, 'consecutiveHoldCycles', 'Multi-Market hold consecutive-cycle counter');
requireText(multiMarket, "starvationState = holdAgeHours >= 72 ? 'STARVED' : holdAgeHours >= 24 ? 'WARNING' : 'NORMAL'", 'Multi-Market hold starvation threshold');
requireText(multiMarket, 'prediction-lab-research-hold-state-${{ github.run_id }}', 'Multi-Market hold durable artifact');
const failureStart = multiMarket.lastIndexOf('- name: Fail workflow when technical validation failed');
const nextJob = multiMarket.indexOf('\n  durable-policy-preflight:', failureStart);
if (failureStart < 0 || nextJob < 0) fail('Multi-Market technical failure step not found');
const technicalFailure = multiMarket.slice(failureStart, nextJob);
forbidText(technicalFailure, "steps.market_suite.outputs.research_ready != 'true'", 'Multi-Market expected research hold');
requireText(technicalFailure, "steps.research_hold.outcome == 'failure'", 'Multi-Market research-hold validation failure guard');

requireText(overviewContract, "safety.readOnlyDashboard !== true", 'overview read-only safety sanitizer');
requireText(overviewContract, "safety.liveTrading !== false", 'overview live-trading safety sanitizer');
requireText(overviewContract, "safety.privateApi !== false", 'overview private-API safety sanitizer');
requireText(overviewContract, "safety.orderAuthority !== false", 'overview order-authority safety sanitizer');
requireText(videoSource, 'profitabilityCredit: 0', 'video profitability credit lock');
requireText(videoSource, "executionAuthority: 'NONE'", 'video execution authority lock');
requireText(workspace, "reason:'ONE_SHOT_ROOT_NOT_CONFIGURED'", 'workspace unavailable-not-zero behavior');

console.log('[research-center-predeploy] PASS');
console.log('[research-center-predeploy] overview=CONNECTED admin capability aligned');
console.log('[research-center-predeploy] video/workspace=CONNECTED read-only/admin nested boundary');
console.log('[research-center-predeploy] paper/full-cost=CONNECTED 8/8 identity contract');
console.log('[research-center-predeploy] promotion=CONNECTED no automatic adoption authority');
console.log('[research-center-predeploy] fast-profitability=CONNECTED canonical receipt + exact run artifacts');
console.log('[research-center-predeploy] multi-market=RESEARCH_HOLD for missing temporal evidence, not technical failure');
