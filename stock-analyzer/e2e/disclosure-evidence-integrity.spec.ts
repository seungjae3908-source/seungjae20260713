import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { buildFilingEvidence, normalizeDisclosureGroupKey } from '../../api-server/src/lib/filing-evidence';

function analyzerDirectory() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? process.cwd()
    : path.resolve(process.cwd(), 'stock-analyzer');
}

function repositoryDirectory() {
  const analyzer = analyzerDirectory();
  return path.dirname(analyzer);
}

test('disclosure UI never presents deterministic classification guidance as AI analysis', () => {
  const source = fs.readFileSync(
    path.join(analyzerDirectory(), 'src/components/tabs/disclosure-tab.tsx'),
    'utf8',
  );

  expect(source).not.toContain('AI 해석:');
  expect(source).toContain('분류 안내:');
  expect(source).toContain('실제 주가 영향은 원문과 재무 내용을 함께 확인하세요.');
  expect(source).toContain('주가 영향 미검증');
  expect(source).not.toContain('주가 영향 확정');
});

test('DART correction and capital raise remain provenance-backed and market impact stays unverified', () => {
  const evidence = buildFilingEvidence({
    source: 'DART',
    title: '[정정] 유상증자 결정',
    date: '2026-08-22',
    collectedAt: '2026-08-22T07:00:00.000Z',
    events: ['RIGHTS_OFFERING'],
  });

  expect(evidence.sourceLabel).toBe('DART');
  expect(evidence.publishedAtPrecision).toBe('DATE_ONLY');
  expect(evidence.revisionStatus).toBe('CORRECTION');
  expect(evidence.materialEventTypes).toContain('CAPITAL_RAISE');
  expect(evidence.importance).toBe('IMPORTANT');
  expect(evidence.importanceProvenance).toBe('DETERMINISTIC_EVENT_TYPE_RULE');
  expect(evidence.marketImpactStatus).toBe('UNVERIFIED');
});

test('critical regulatory events are highlighted without pretending price direction is verified', () => {
  const evidence = buildFilingEvidence({
    source: 'DART',
    title: '주권매매 거래정지 및 상장폐지 관련 안내',
    date: '2026-08-22',
    collectedAt: '2026-08-22T07:00:00.000Z',
    events: ['DELISTING'],
  });

  expect(evidence.materialEventTypes).toEqual(expect.arrayContaining(['TRADING_SUSPENSION', 'DELISTING']));
  expect(evidence.importance).toBe('CRITICAL');
  expect(evidence.marketImpactStatus).toBe('UNVERIFIED');
});

test('SEC amendment is separated from original filing semantics', () => {
  const evidence = buildFilingEvidence({
    source: 'SEC_EDGAR',
    title: '10-K/A annual report amendment',
    form: '10-K/A',
    date: '2026-08-22',
    collectedAt: '2026-08-22T07:00:00.000Z',
    events: [],
  });

  expect(evidence.sourceLabel).toBe('SEC EDGAR');
  expect(evidence.revisionStatus).toBe('AMENDMENT');
  expect(evidence.materialEventTypes).toContain('EARNINGS');
  expect(normalizeDisclosureGroupKey('10-K/A annual report')).toBe(normalizeDisclosureGroupKey('10-K annual report'));
});

test('backend and UI expose regulatory source, timing, relation, importance provenance and related links', () => {
  const backend = fs.readFileSync(
    path.join(repositoryDirectory(), 'api-server/src/services/filing.service.ts'),
    'utf8',
  );
  const ui = fs.readFileSync(
    path.join(analyzerDirectory(), 'src/components/tabs/disclosure-tab.tsx'),
    'utf8',
  );

  expect(backend).toContain("source: 'SEC_EDGAR'");
  expect(backend).toContain("source: 'DART'");
  expect(backend).toContain('relatedItems');
  expect(ui).toContain('원출처:');
  expect(ui).toContain('공시 발표:');
  expect(ui).toContain('앱 수집:');
  expect(ui).toContain('중요도 근거:');
  expect(ui).toContain('이전/관련 공시');
  expect(ui).toContain('원문 링크 미제공');
});
