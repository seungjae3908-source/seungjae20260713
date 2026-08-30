import { useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { restoreRemoteBackup, saveBackupNow, startAutoBackup, useBackupStatus } from '@/lib/backup-sync';

const buttonClass = 'min-h-11 rounded-xl border border-card-border px-3 py-2 text-xs font-bold disabled:opacity-50';

export function BackupSettings() {
  const auth = useAuth();
  const status = useBackupStatus();
  const memberId = auth.isApproved ? auth.user?.id : null;
  const current = memberId && status.memberId === memberId ? status : null;
  const [intent, setIntent] = useState<'restore' | 'save' | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [restored, setRestored] = useState(false);
  const lock = useRef(false);

  async function confirm() {
    if (!memberId || !intent || lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try {
      if (intent === 'restore') {
        const count = await restoreRemoteBackup(memberId);
        setRestored(true);
        setMessage(`설정 ${count}개를 복원했습니다. 새로고침하여 적용하세요.`);
      } else {
        await saveBackupNow(memberId);
        setMessage('전송 내용과 서버 확인 응답이 일치합니다.');
      }
      setIntent(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '백업 작업을 확인하지 못했습니다.');
    } finally { lock.current = false; setBusy(false); }
  }

  return <section className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4" data-testid="backup-settings">
    <h3 className="text-sm font-bold">설정 백업·복원</h3>
    <p className="text-xs leading-5 text-muted-foreground">화면 설정·관심종목 등 허용된 설정만 저장합니다. 거래소 계좌·Secret·모의거래 원장은 포함하지 않습니다. 운영 DB 재해복구 검증과는 별개입니다.</p>
    <p role="status" className="break-words text-xs">{current?.message ?? '백업 상태 미확인'}</p>
    <dl className="grid grid-cols-2 gap-2 text-xs">
      <dt>확인 상태</dt><dd>{current?.mode ?? 'UNKNOWN'}</dd>
      <dt>항목 수</dt><dd>{current?.itemCount ?? '미확인'}</dd>
      <dt>서버 저장 시각 (KST)</dt><dd className="break-words">{current?.remoteUpdatedAt ? new Date(current.remoteUpdatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '미확인'}</dd>
    </dl>
    <div className="grid gap-2 sm:grid-cols-3">
      <button className={buttonClass} disabled={!memberId || busy} onClick={() => memberId && void startAutoBackup(memberId)}>자동백업 재확인</button>
      <button className={buttonClass} disabled={!memberId || busy} onClick={() => { setMessage(''); setIntent('restore'); }}>서버 설정 복원</button>
      <button className={buttonClass} disabled={!memberId || busy} onClick={() => { setMessage(''); setIntent('save'); }}>현재 설정 저장</button>
    </div>
    {intent ? <div role="alertdialog" aria-label="설정 백업 변경 확인" className="space-y-3 rounded-xl border border-amber-500/40 p-3">
      <p className="text-xs leading-5">{intent === 'restore'
        ? '서버 백업의 버전과 체크섬을 검증한 후 이 브라우저의 백업 대상 설정을 교체합니다. 진행할까요?'
        : '현재 브라우저의 백업 대상 설정으로 서버의 최신 백업 1개를 덮어씁니다. 진행할까요?'}</p>
      <div className="grid grid-cols-2 gap-2">
        <button className={buttonClass} disabled={busy} onClick={() => setIntent(null)}>취소</button>
        <button className={buttonClass} disabled={busy} onClick={() => void confirm()}>{busy ? '확인 중' : '변경 승인'}</button>
      </div>
    </div> : null}
    {message ? <p role="status" className="break-words text-xs">{message}</p> : null}
    {restored ? <button className={buttonClass} onClick={() => window.location.reload()}>새로고침하여 적용</button> : null}
  </section>;
}
