import { expect, test } from '@playwright/test';
import { adminMemberAccessLabel, adminMemberEditableTier, adminMemberIsActive } from '../src/lib/member-admin-state';
test('pending, revoked, rejected and withdrawn stale admin roles default to pending', () => {
  for (const status of ['pending','revoked','rejected','withdrawn','disabled','inactive']) {
    const member = { status, membership_level: 'admin', role: 'admin', is_active: true };
    expect(adminMemberEditableTier(member)).toBe('pending');
    expect(adminMemberAccessLabel(member)).toBe('이용 차단');
  }
});
test('suspended legacy tier is retained for explicit restoration, not access', () => {
  expect(adminMemberEditableTier({ status:'suspended', role:'admin', membership_level:'admin', is_active:false })).toBe('admin');
  expect(adminMemberEditableTier({ status:'suspended', role:'associate', membership_level:null, is_active:false })).toBe('associate');
  expect(adminMemberAccessLabel({ status:'suspended', membership_level:'admin', is_active:false })).toBe('이용 차단');
});
test('null/missing canonical activity and expired membership are not active', () => {
  for (const flag of [null,undefined,false]) {
    const state = {status:'approved',membership_level:'associate',is_active:flag};
    expect(adminMemberIsActive(state)).toBe(false);
    expect(adminMemberAccessLabel(state)).toBe('비활성');
  }
  expect(adminMemberAccessLabel({status:'approved',membership_level:'regular',is_active:true,membership_expires_at:'2020-01-01T00:00:00Z'})).toBe('만료');
  expect(adminMemberAccessLabel({status:'approved',membership_level:'regular',is_active:true,membership_expires_at:'invalid'})).toBe('만료일 확인 필요');
  expect(adminMemberAccessLabel({status:'approved',role:'admin',membership_level:null,is_active:true})).toBe('등급 확인 필요');
  expect(adminMemberAccessLabel({status:'approved',membership_level:'associate',is_active:true})).toBe('활성');
});
