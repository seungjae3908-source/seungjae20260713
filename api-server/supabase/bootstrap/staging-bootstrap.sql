\set ON_ERROR_STOP on

-- This manifest is only for a newly created, isolated staging Supabase project.
-- It contains no production export and imports no production rows.
\ir staging-empty-project-guard.sql
\ir ../../../supabase/migrations/20260716_full_schema_idempotent.sql
\ir ../schema.sql
\ir ../../../supabase/migrations/20260717_fix_profiles_rls_recursion.sql
\ir ../migrations/2026080201_journal_sync_analytics_phase7.sql
\ir ../migrations/2026080202_release_candidate_permissions_phase8.sql
\ir ../migrations/2026080203_phase8_paper_capability_rls.sql
\ir ../migrations/2026080301_trade_automation_integration.sql
\ir staging-bootstrap-assert.sql
