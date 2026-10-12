/** Source/bundle guard complements the executable fake-provider contract tests.
 * Verified readonly contracts replace the old unconditional UNVERIFIED marker;
 * dropping that marker must not drop the actual safety requirements. */
export function kiwoomReadonlyRecoverySecurityFailures(recovery, contract) {
  const failures = [];
  const require = (condition, code) => { if (!condition) failures.push(code); };
  require(recovery.includes("from './kiwoom-readonly-order-recovery.service'")
    && recovery.includes('kiwoomRecoveryOrderIdentityValid(plan, order)')
    && recovery.includes('readCompleteKiwoomOrderRows(request,')
    && recovery.includes('kiwoomReadonlyRecoverySnapshot('), 'KIWOOM_RECOVERY_GUARDED_READER_NOT_CONNECTED');
  for (const [api, route, rows] of [
    ['ka10075', '/api/dostk/acnt', 'oso'], ['kt00007', '/api/dostk/acnt', 'acnt_ord_cntr_prps_dtl'],
    ['ust21050', '/api/us/acnt', 'result_list'], ['ust21150', '/api/us/acnt', 'result_list'],
  ]) require(contract.includes(`['${api}', { path: '${route}', rows: '${rows}' }]`), `KIWOOM_RECOVERY_READ_ALLOWLIST_INVALID:${api}`);
  for (const code of ['KIWOOM_RECOVERY_READ_CONTRACT_REQUIRED', 'KIWOOM_RECOVERY_API_ID_MISMATCH',
    'KIWOOM_RECOVERY_CONTINUATION_INVALID', 'KIWOOM_RECOVERY_PAGINATION_BOUND_EXCEEDED',
    'KIWOOM_RECOVERY_ORDER_ROW_AMBIGUOUS', 'KIWOOM_ORDER_IDENTITY_MISMATCH',
    'KIWOOM_ORDER_STATUS_UNKNOWN', 'KIWOOM_ORDER_STATUS_QUANTITY_MISMATCH',
    'KIWOOM_RECOVERY_AMENDMENT_REQUIRES_REVIEW']) {
    require(contract.includes(`throw new Error('${code}')`), `KIWOOM_RECOVERY_FAIL_CLOSED_GUARD_MISSING:${code}`);
  }
  require(contract.includes("request.method !== 'POST' || !contract || request.path !== contract.path || request.query !== ''"),
    'KIWOOM_RECOVERY_NON_QUERY_TRANSPORT_NOT_BLOCKED');
  require(contract.includes('seenKeys.has(key)') && contract.includes('part.length === 0'),
    'KIWOOM_RECOVERY_PAGINATION_COMPLETENESS_NOT_PROVEN');
  require((contract.match(/throw new Error\('KIWOOM_ORDER_STATUS_UNKNOWN'\)/gu) ?? []).length === 2,
    'KIWOOM_RECOVERY_FULL_AND_PARTIAL_STATUS_GUARDS_REQUIRED');
  require(contract.includes('feeAmount: null, feeCurrency: null') && contract.includes('fills: []'),
    'KIWOOM_RECOVERY_UNKNOWN_COST_OR_TRADE_ID_INVENTED');
  require(!/prepareKiwoom(?:Order|Cancel|Amend)\s*\(|\/api\/(?:dostk|us)\/ord\b/u.test(`${recovery}\n${contract}`),
    'KIWOOM_RECOVERY_FINANCIAL_MUTATION_SURFACE_PRESENT');
  return failures;
}
