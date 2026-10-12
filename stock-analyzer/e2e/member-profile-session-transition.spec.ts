import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { shouldClearMemberProfileOnSessionChange } from '../src/lib/member-profile-session-transition';

const source = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/auth.tsx'), 'utf8');

test('switching from an admin profile to a different user invalidates the previous capabilities', () => {
  expect(shouldClearMemberProfileOnSessionChange('admin-user', 'associate-user')).toBe(true);
  expect(shouldClearMemberProfileOnSessionChange('associate-user', 'admin-user')).toBe(true);
  expect(shouldClearMemberProfileOnSessionChange(null, 'new-user')).toBe(true);
  expect(shouldClearMemberProfileOnSessionChange('old-user', null)).toBe(true);
});

test('same-user session token refresh does not flash or invalidate valid cached profile', () => {
  expect(shouldClearMemberProfileOnSessionChange('same-user', 'same-user')).toBe(false);
  expect(shouldClearMemberProfileOnSessionChange(null, null)).toBe(false);
});

test('AuthProvider applies identity barrier before installing the next session', () => {
  const block = source.split('  function applySession(next: Session | null) {')[1]?.split('  function loadProfile(')[0] ?? '';
  expect(block).toContain('const previousUserId = sessionRef.current?.user.id ?? null;');
  expect(block).toContain('const nextUserId = next?.user.id ?? null;');
  expect(block).toContain('if (!next || shouldClearMemberProfileOnSessionChange(previousUserId, nextUserId)) applyProfile(null);');
  expect(block.indexOf('applyProfile(null);')).toBeLessThan(block.indexOf('sessionRef.current = next;'));
  expect(block).toContain('profileRequestsRef.current.setIdentity(nextUserId, requestKey);');
  expect(block).toContain('userIntegrationsRequestLifecycle.setIdentity(nextUserId, requestKey);');
});
