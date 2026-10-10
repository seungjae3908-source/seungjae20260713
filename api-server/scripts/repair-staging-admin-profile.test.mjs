import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildStagingAdminProfileRepair,
  classifyStagingAdminProfileRepair,
} from './repair-staging-admin-profile.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const pending = Object.freeze({
  id,
  status: 'pending',
  is_active: false,
  membership_level: 'pending',
  role: 'user',
  membership_expires_at: null,
});

test('only the exact configured pending inactive profile is repairable', () => {
  assert.equal(classifyStagingAdminProfileRepair(pending, id), 'STAGING_ADMIN_PROFILE_REPAIRABLE');
  assert.equal(classifyStagingAdminProfileRepair({ ...pending, id: crypto.randomUUID() }, id), 'STAGING_ADMIN_PROFILE_REPAIR_IDENTITY_MISMATCH');
  for (const value of [
    { ...pending, status: 'suspended' },
    { ...pending, status: 'rejected' },
    { ...pending, is_active: true },
    { ...pending, membership_level: 'regular' },
    { ...pending, role: 'admin' },
  ]) assert.equal(classifyStagingAdminProfileRepair(value, id), 'STAGING_ADMIN_PROFILE_REPAIR_UNSAFE_CURRENT_STATE');
});

test('repair patch grants only canonical unexpired admin profile fields', () => {
  const now = '2026-10-10T00:00:00.000Z';
  assert.deepEqual(buildStagingAdminProfileRepair(pending, id, now), {
    status: 'approved',
    is_active: true,
    membership_level: 'admin',
    role: 'admin',
    membership_expires_at: null,
    approved_at: now,
    approved_by: null,
    permissions_updated_at: now,
    updated_at: now,
  });
});

test('already-ready and unsafe profiles cannot generate a mutation patch', () => {
  const ready = {
    ...pending,
    status: 'approved',
    is_active: true,
    membership_level: 'admin',
    role: 'admin',
  };
  assert.equal(classifyStagingAdminProfileRepair(ready, id), 'STAGING_ADMIN_PROFILE_ALREADY_READY');
  assert.throws(() => buildStagingAdminProfileRepair(ready, id, new Date().toISOString()), /ALREADY_READY/u);
  assert.throws(() => buildStagingAdminProfileRepair({ ...pending, status: 'withdrawn' }, id, new Date().toISOString()), /UNSAFE_CURRENT_STATE/u);
});
