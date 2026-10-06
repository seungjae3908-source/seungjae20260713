export function classifyProductionPaperJournalPrivilegeFailure(result) {
  if (result.error) return 'psql_process_failed';

  const stderr = String(result.stderr ?? '');
  const knownFailures = [
    [/PAPER_JOURNAL_TABLE_MISSING:/, 'paper_journal_table_missing'],
    [/PAPER_JOURNAL_RLS_DISABLED:/, 'paper_journal_rls_disabled'],
    [/PAPER_JOURNAL_AUTHENTICATED_CRUD_MISSING:/, 'paper_journal_authenticated_crud_missing'],
    [/PAPER_JOURNAL_ANON_PRIVILEGE_EXPOSED:/, 'paper_journal_anon_privilege_exposed'],
    [/PAPER_JOURNAL_PUBLIC_PRIVILEGE_EXPOSED:/, 'paper_journal_public_privilege_exposed'],
    [/PAPER_JOURNAL_ROWS_CHANGED/, 'paper_journal_rows_changed_in_transaction'],
    [/PAPER_JOURNAL_POLICIES_CHANGED/, 'paper_journal_policies_changed_in_transaction'],
    [/PAPER_JOURNAL_GRANT_COUNT_INVALID/, 'paper_journal_grant_count_invalid'],
    [/canceling statement due to lock timeout/i, 'database_lock_timeout'],
    [/canceling statement due to statement timeout/i, 'database_statement_timeout'],
    [/could not serialize access/i, 'database_serialization_conflict'],
    [/(?:permission denied|must be owner)/i, 'database_privilege_denied'],
    [/role .* does not exist/i, 'database_required_role_missing'],
    [/relation .* does not exist/i, 'database_required_relation_missing'],
    [/function .* does not exist/i, 'database_required_capability_missing'],
    [/syntax error/i, 'database_sql_contract_invalid'],
    [/(?:could not connect|connection .* failed|server closed the connection)/i, 'database_connection_failed'],
  ];
  for (const [pattern, classification] of knownFailures) {
    if (pattern.test(stderr)) return classification;
  }

  const phaseMarkers = [...String(result.stdout ?? '').matchAll(/__PAPER_JOURNAL_PHASE__:(\w+)/g)];
  const phase = phaseMarkers.at(-1)?.[1];
  return phase ? `atomic_${phase}_failed` : 'atomic_privilege_migration_failed';
}
