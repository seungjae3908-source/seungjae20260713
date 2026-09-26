type JsonRecord = Record<string, unknown>;

export type KiwoomReadApiId = 'ka00001' | 'kt00018' | 'ust21070';

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertProviderSuccess(record: JsonRecord): void {
  const rawCode = record.return_code;
  if (rawCode == null || rawCode === '') return;
  const code = Number(rawCode);
  if (!Number.isFinite(code)) throw new Error('KIWOOM_RESPONSE_MALFORMED');
  if (code !== 0) throw new Error('KIWOOM_PROVIDER_ERROR');
}

export function validateKiwoomReadResponse(apiId: KiwoomReadApiId, payload: unknown): JsonRecord {
  if (!isRecord(payload)) throw new Error('KIWOOM_RESPONSE_MALFORMED');
  assertProviderSuccess(payload);

  if (apiId === 'ka00001') {
    const accountNumber = typeof payload.acctNo === 'string' ? payload.acctNo.trim() : '';
    if (!accountNumber) throw new Error('KIWOOM_RESPONSE_MALFORMED');
    return payload;
  }

  if (apiId === 'kt00018') {
    if (hasOwn(payload, 'acnt_evlt_remn_indv_tot') && !Array.isArray(payload.acnt_evlt_remn_indv_tot)) {
      throw new Error('KIWOOM_RESPONSE_MALFORMED');
    }
    const hasAccountPayload = Array.isArray(payload.acnt_evlt_remn_indv_tot)
      || hasOwn(payload, 'tot_evlt_amt')
      || hasOwn(payload, 'prsm_dpst_aset_amt')
      || hasOwn(payload, 'tot_pur_amt');
    if (!hasAccountPayload) throw new Error('KIWOOM_RESPONSE_MALFORMED');
    return payload;
  }

  if (hasOwn(payload, 'result_list') && !Array.isArray(payload.result_list)) {
    throw new Error('KIWOOM_RESPONSE_MALFORMED');
  }
  const hasAccountPayload = Array.isArray(payload.result_list)
    || hasOwn(payload, 'tot_evlt_amt')
    || hasOwn(payload, 'crnc_code');
  if (!hasAccountPayload) throw new Error('KIWOOM_RESPONSE_MALFORMED');
  return payload;
}
