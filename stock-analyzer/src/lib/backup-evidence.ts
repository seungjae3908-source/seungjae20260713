import { evidenceInstant, evidenceRecord } from './server-evidence';

export type BackupEvidence = {
  ok: true; exists: true; schemaVersion: 1; itemCount: number; checksum: string;
  updatedAt: string; clientUpdatedAt: string | null; localStorage?: Record<string, string>;
} | { ok: true; exists: false };

export function parseBackupEvidence(value: unknown, now = Date.now()): BackupEvidence {
  if (!evidenceRecord(value) || value.ok !== true || typeof value.exists !== 'boolean') throw new Error('백업 응답 형식을 확인하지 못했습니다.');
  if (!value.exists) {
    if (['localStorage', 'checksum', 'updatedAt', 'itemCount', 'schemaVersion'].some((key) => value[key] !== undefined)) {
      throw new Error('백업 존재 여부와 응답 내용이 일치하지 않습니다.');
    }
    return { ok: true, exists: false };
  }
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.itemCount)
    || typeof value.itemCount !== 'number' || value.itemCount < 0 || value.itemCount > 500
    || typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(value.checksum)
    || !evidenceInstant(value.updatedAt, now)
    || !(value.clientUpdatedAt === null || evidenceInstant(value.clientUpdatedAt, now))) {
    throw new Error('백업 버전·항목 수·서버 저장 시각·체크섬 근거가 유효하지 않습니다.');
  }
  if (value.localStorage !== undefined && (!evidenceRecord(value.localStorage)
    || Object.values(value.localStorage).some((item) => typeof item !== 'string')
    || Object.keys(value.localStorage).length !== value.itemCount)) throw new Error('백업 내용과 항목 수가 일치하지 않습니다.');
  return value as BackupEvidence;
}

export async function backupChecksum(payload: Record<string, string>): Promise<string> {
  const sorted = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)));
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sorted)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyBackupAcknowledgement(value: unknown, payload: Record<string, string>, clientUpdatedAt: string) {
  const backup = parseBackupEvidence(value);
  if (!backup.exists || backup.itemCount !== Object.keys(payload).length
    || Date.parse(backup.clientUpdatedAt ?? '') !== Date.parse(clientUpdatedAt)
    || backup.checksum !== await backupChecksum(payload)) throw new Error('서버 백업 확인 응답이 전송 내용과 일치하지 않습니다.');
  return backup;
}
