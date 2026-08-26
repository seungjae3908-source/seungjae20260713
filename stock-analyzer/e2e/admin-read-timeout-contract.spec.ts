import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const source = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/admin.tsx'), 'utf8');

test('admin member and audit reads cannot remain loading forever', () => {
  expect(source).toContain('const ADMIN_REQUEST_TIMEOUT_MS = 8_000;');
  expect(source).toContain('const controller = new AbortController();');
  expect(source).toContain('window.setTimeout(() => {');
  expect(source).toContain('timedOut = true;');
  expect(source).toContain('controller.abort();');
  expect(source).toContain("throw new Error('관리자 요청 시간이 초과됐습니다. 다시 시도해 주세요.')");
  expect(source).toContain('window.clearTimeout(timeout);');
});

test('react-query cancellation and retry state stay bounded and explicit', () => {
  expect(source).toContain('queryFn: ({ signal }) => adminFetch');
  expect(source.match(/retry: false,/g)).toHaveLength(2);
  expect(source.match(/refetchOnWindowFocus: false,/g)).toHaveLength(2);
  expect(source).toContain('data-testid="admin-members-unavailable"');
  expect(source).toContain('회원 목록 다시 시도');
  expect(source).toContain('data-testid="admin-audit-unavailable"');
  expect(source).toContain('감사 이력 다시 시도');
});

test('audit read failure is never rendered as a truthful empty history', () => {
  expect(source).toContain("!audits.isLoading && !audits.error && audits.data?.logs.length === 0");
  expect(source).not.toContain("!audits.isLoading && !audits.data?.logs.length");
});
