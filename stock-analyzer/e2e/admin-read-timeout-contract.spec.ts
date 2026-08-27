import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const source = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/admin.tsx'), 'utf8');

test('admin member and audit GET reads cannot remain loading forever', () => {
  expect(source).toContain('const ADMIN_REQUEST_TIMEOUT_MS = 8_000;');
  expect(source).toContain("const method = (init?.method ?? 'GET').toUpperCase();");
  expect(source).toContain("if (method !== 'GET') {");
  expect(source).toContain('const controller = new AbortController();');
  expect(source).toContain('window.setTimeout(() => {');
  expect(source).toContain('timedOut = true;');
  expect(source).toContain('controller.abort();');
  expect(source).toContain("throw new Error('관리자 요청 시간이 초과됐습니다. 다시 시도해 주세요.')");
  expect(source).toContain('window.clearTimeout(timeout);');
});

test('admin PATCH and POST writes never inherit the read timeout abort controller', () => {
  const writeBranchStart = source.indexOf("if (method !== 'GET') {");
  const readControllerStart = source.indexOf('const controller = new AbortController();');
  expect(writeBranchStart).toBeGreaterThan(-1);
  expect(readControllerStart).toBeGreaterThan(writeBranchStart);
  const writeBranch = source.slice(writeBranchStart, readControllerStart);
  expect(writeBranch).toContain('signal: undefined,');
  expect(writeBranch).not.toContain('setTimeout');
  expect(writeBranch).not.toContain('controller.abort');
  expect(source).toContain("method: 'PATCH'");
  expect(source).toContain("method: 'POST'");
});

test('react-query cancellation, stale data, and member mutations stay fail closed', () => {
  expect(source).toContain('queryFn: ({ signal }) => adminFetch');
  expect(source.match(/retry: false,/g)).toHaveLength(2);
  expect(source.match(/refetchOnWindowFocus: false,/g)).toHaveLength(2);
  expect(source).toContain('data-testid="admin-members-unavailable"');
  expect(source).toContain('회원 목록 다시 시도');
  expect(source).toContain('const memberMutationEnabled = Boolean(members.data) && !members.error && !members.isFetching;');
  expect(source).toContain("if (!memberMutationEnabled) { setError('회원 목록의 최신 상태를 확인한 뒤 다시 시도해 주세요.'); return; }");
  expect(source).toContain('mutationEnabled={memberMutationEnabled}');
  expect(source).toContain('data-testid="admin-member-mutations-locked"');
  expect(source).toContain("disabled={busy || !mutationEnabled || initialTier !== 'pending'}");
  expect(source).toContain('disabled={busy || !mutationEnabled}');
});

test('audit read failure is never rendered as a truthful empty or current history', () => {
  expect(source).toContain('data-testid="admin-audit-unavailable"');
  expect(source).toContain('data-testid="admin-audit-stale"');
  expect(source).toContain('아래 이력은 마지막 정상 조회 데이터입니다. 현재 조회는 실패했습니다.');
  expect(source).toContain("!audits.isLoading && !audits.error && audits.data?.logs.length === 0");
  expect(source).not.toContain("!audits.isLoading && !audits.data?.logs.length");
});
