\set ON_ERROR_STOP on

-- Allowlisted staging bootstrap manifest.
-- The automated runner reads these exact files, removes only their outer
-- transaction envelopes, executes the chain twice inside one transaction,
-- and runs the final assertions before commit. Do not use production exports.
\ir staging-empty-project-guard.sql
\ir staging-bootstrap-helpers.sql
\ir staging-allowlist-base.sql
\ir ../migrations/2026080201_journal_sync_analytics_phase7.sql
\ir ../migrations/2026080202_release_candidate_permissions_phase8.sql
\ir ../migrations/2026080203_phase8_paper_capability_rls.sql
\ir ../migrations/2026080301_trade_automation_integration.sql
\ir ../migrations/2026080501_paper_journal_authenticated_privileges.sql
\ir ../migrations/2026080502_member_permission_audit_authenticated_privileges.sql
\ir ../migrations/2026081501_personal_telegram_storage.sql
\ir staging-bootstrap-assert.sql
\ir staging-audit-privilege-assert.sql
