#!/usr/bin/env node
// Prints the whole research center in plain Korean: combination search
// (with cumulative trials), exploratory forward paper ledger, operations
// watchdog, universe status and paper discovery. Read-only.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { formatCombinationReportKoV1 } from '../src/combination-search-lane-v1.mjs';
import { formatExploratoryPaperReportKoV1 } from '../src/exploratory-paper-ledger-v1.mjs';

const root = resolve(process.argv[2] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
async function latest(name) {
  try { return JSON.parse(await readFile(join(root, 'latest', name), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

const out = [];
const combination = await latest('combination-research-v1.json');
out.push(combination ? formatCombinationReportKoV1(combination) : '아직 조합 연구 결과가 없습니다.');
out.push('');
const paper = await latest('exploratory-paper-ledger-v1.json');
out.push(paper ? formatExploratoryPaperReportKoV1(paper) : '아직 탐색용 모의매매 결과가 없습니다.');
out.push('');
const watchdog = await latest('ops-watchdog-v1.json');
if (watchdog) {
  out.push(`[운영 감시] ${watchdog.observedAt} · 정상 ${watchdog.healthy}개 · 문제 ${watchdog.problems.length ? watchdog.problems.join(', ') : '없음'} · 알림 채널 ${watchdog.alertChannel === 'TELEGRAM' ? '텔레그램' : '미설정(RESEARCH_OPS_TELEGRAM_BOT_TOKEN/CHAT_ID 필요)'}`);
}
const universe = await (async () => { try { return JSON.parse(await readFile(join(root, 'research-universe-v2', 'snapshot.json'), 'utf8')); } catch { return null; } })();
if (universe) {
  const rows = Object.entries(universe.sources ?? {}).map(([source, row]) => `${source}: 상장 ${row.listed} · 유동성 통과 ${row.liquid} · 연구 ${row.research.length} · 감시 ${row.watch.length}`);
  out.push(`[전 종목 목록 V2] ${rows.length ? rows.join(' / ') : '아직 수집 중 (완료 전까지 기존 20종목 사용)'} · 상장폐지 종목 미포함(생존편향 있음)`);
}
const papers = await latest('paper-discovery-v1.json');
if (papers?.latestPending?.length) {
  out.push(`[논문 발굴] 승인 대기 초안 ${papers.pendingApproval}개`);
  for (const row of papers.latestPending.slice(0, 5)) out.push(`  - ${row.title} (${row.url}) → ${row.drafts.map((d) => `${d.laneId}: ${d.atoms.join(' + ')}`).join(' | ')}`);
}
process.stdout.write(`${out.join('\n')}\n`);
