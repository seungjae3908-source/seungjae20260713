import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('account UI keeps primary touch targets at least 44px and avoids provider jargon', () => {
  const account = source('src/pages/account.tsx');

  expect(account).toContain('aria-label="뒤로 가기"');
  expect(account).toContain('className="flex h-11 w-11');
  expect(account).toContain('aria-label="로그인 탭"');
  expect(account).toContain('aria-label="회원가입 탭"');
  expect(account).toContain('min-h-11 flex-1 rounded-xl');
  expect(account).toContain('className="input"');
  expect(account).toContain('[&_.input]:h-12');
  expect(account).toContain('type="submit" disabled={busy}');
  expect(account).toContain('min-h-12 w-full');
  expect(account).toContain('type="button" onClick={() => void auth.signOut()}');
  expect(account).toContain('계정 저장소 연결 정보를 관리자 설정에 등록해 주세요.');
  expect(account).not.toContain('Supabase 연결 정보를 관리자 설정에 등록해 주세요.');
  expect(account).toContain("role={error ? 'alert' : 'status'}");
});
