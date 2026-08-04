import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const [engine, component, page, routes] = await Promise.all([
  readFile(path.join(root, 'stock-analyzer/src/lib/stock-analysis-engine.ts'), 'utf8'),
  readFile(path.join(root, 'stock-analyzer/src/components/stock-analysis-hub.tsx'), 'utf8'),
  readFile(path.join(root, 'stock-analyzer/src/pages/stock-info.tsx'), 'utf8'),
  readFile(path.join(root, 'api-server/src/routes/index.ts'), 'utf8'),
]);

assert(engine.includes('export function buildStockAnalysis'), 'deterministic analysis engine export missing');
assert(engine.includes("type: 'development_failure'"), 'development failure event rule missing');
assert(engine.includes("type: 'development_delay'"), 'development delay event rule missing');
assert(engine.includes("type: 'contract_win'"), 'contract event rule missing');
assert(engine.includes("type: 'dilution'"), 'dilution event rule missing');
assert(engine.includes("quantum:"), 'quantum sector module missing');
assert(engine.includes("semiconductor:"), 'semiconductor sector module missing');
assert(engine.includes("biotech:"), 'biotech sector module missing');
assert(engine.includes("ai:"), 'AI sector module missing');
assert(engine.includes('sourceMeta'), 'source reliability handling missing');
assert(engine.includes('collectEvidence'), 'evidence collection missing');
assert(engine.includes('normalizedTitle'), 'duplicate evidence normalization missing');
assert(engine.includes("'경쟁사 최신 정량 비교자료'"), 'missing competitor data must be explicit');
assert(component.includes('AI 종합평가'), 'analysis summary UI missing');
assert(component.includes('자체엔진'), 'self-engine disclosure missing');
assert(component.includes('기존 전망 변경'), 'analysis revision UI missing');
assert(component.includes('왜 오를 수 있나?'), 'upside factor UI missing');
assert(component.includes('왜 떨어질 수 있나?'), 'downside factor UI missing');
assert(component.includes('분석 신뢰도'), 'confidence UI missing');
assert(component.includes('투자 권유 아님'), 'investment warning missing');
assert(component.includes('sa-stock-analysis-history-v1'), 'local revision history missing');
assert(page.includes("import { StockAnalysisHub } from '@/components/stock-analysis-hub';"), 'analysis hub is not imported by information page');
assert(page.includes('<StockAnalysisHub'), 'analysis hub is not rendered in information page');
assert(routes.includes('router.use(requireAuthenticated);'), 'information APIs must remain authenticated');
assert(routes.includes("router.use(requireCapability('canAccessBasicInfo'));"), 'basic information capability gate missing');
assert(!engine.includes('openai'), 'analysis engine must not require OpenAI');
assert(!component.includes('/auto-trade/execute'), 'analysis hub must not execute orders');
assert(!page.includes('StockAnalysisHub') || !page.includes('/auto-trade/execute'), 'information page must not connect analysis to order execution');

console.log('[info-analysis-hub-contract] engine, sector modules, event revisions, confidence, permissions, and order separation passed');
