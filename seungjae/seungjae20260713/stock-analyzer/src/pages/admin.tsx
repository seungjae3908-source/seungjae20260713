import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Image as ImageIcon,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Upload,
  Users,
  Wrench,
} from 'lucide-react';
import { useAuth, type MemberProfile } from '@/lib/auth';

async function adminFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof payload.error === 'string' ? payload.error : `HTTP_${response.status}`;
    const message = typeof payload.message === 'string' ? payload.message : code;
    throw new Error(message);
  }
  return payload as T;
}

type AdminTab = 'members' | 'repair';
type IconJobStatus =
  | 'staged_awaiting_approval'
  | 'source_applied_build_pending'
  | 'rolled_back'
  | 'cancelled'
  | 'failed';

type IconJobFile = {
  key: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  targetRelativePath: string;
};

type IconJob = {
  id: string;
  kind: 'pwa_icon_change';
  status: IconJobStatus;
  sourceName: string;
  note: string;
  backgroundColor: string;
  createdAt: string;
  createdByName: string;
  appliedAt?: string;
  rolledBackAt?: string;
  error?: string;
  buildCommand: string;
  approvalPhrase?: string;
  files: IconJobFile[];
};

type IconJobsResponse = {
  ok: true;
  jobs: IconJob[];
  policy: {
    buildsAutomatically: boolean;
    appliesSourceOnlyAfterApproval: boolean;
    approvalPhrase: string;
    supportedTargets: string[];
  };
};

type GeneratedIcons = {
  favicon: string;
  appleTouch: string;
  icon192: string;
  icon512: string;
  maskable512: string;
};

function loadImage(file: File): Promise<{ image: HTMLImageElement; cleanup: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, cleanup: () => URL.revokeObjectURL(url) });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 읽지 못했습니다. PNG, JPG 또는 WEBP 파일인지 확인해 주세요.'));
    };
    image.src = url;
  });
}

function drawSquareIcon(
  image: HTMLImageElement,
  size: number,
  backgroundColor: string,
  paddingRatio: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('브라우저에서 아이콘 변환 기능을 사용할 수 없습니다.');

  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, size, size);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  const available = size * (1 - paddingRatio * 2);
  const scale = Math.min(available / image.naturalWidth, available / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const x = (size - width) / 2;
  const y = (size - height) / 2;
  context.drawImage(image, x, y, width, height);
  return canvas.toDataURL('image/png');
}

async function generateIcons(file: File, backgroundColor: string): Promise<GeneratedIcons> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('PNG, JPG 또는 WEBP 이미지만 사용할 수 있습니다.');
  }
  if (file.size > 8 * 1024 * 1024) throw new Error('원본 이미지는 8MB 이하여야 합니다.');

  const { image, cleanup } = await loadImage(file);
  try {
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('이미지 크기를 확인할 수 없습니다.');
    return {
      favicon: drawSquareIcon(image, 64, backgroundColor, 0.04),
      appleTouch: drawSquareIcon(image, 180, backgroundColor, 0.05),
      icon192: drawSquareIcon(image, 192, backgroundColor, 0.05),
      icon512: drawSquareIcon(image, 512, backgroundColor, 0.05),
      maskable512: drawSquareIcon(image, 512, backgroundColor, 0.14),
    };
  } finally {
    cleanup();
  }
}

function statusText(status: IconJobStatus): string {
  if (status === 'staged_awaiting_approval') return '서버 업로드 완료 · 소스 적용 승인 대기';
  if (status === 'source_applied_build_pending') return '소스 적용 완료 · 빌드 전 승인 대기';
  if (status === 'rolled_back') return '변경 전 상태로 원복 완료';
  if (status === 'failed') return '작업 실패 · 원복 가능 여부 확인 필요';
  return '취소됨';
}

function statusClass(status: IconJobStatus): string {
  if (status === 'source_applied_build_pending') return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  if (status === 'staged_awaiting_approval') return 'bg-primary/10 text-primary';
  if (status === 'rolled_back') return 'bg-positive/10 text-positive';
  if (status === 'failed') return 'bg-destructive/10 text-destructive';
  return 'bg-secondary text-muted-foreground';
}

function MembersPanel({ token }: { token: string }) {
  const client = useQueryClient();
  const members = useQuery<{ members: MemberProfile[] }>({
    queryKey: ['admin-members'],
    queryFn: () => adminFetch('/members', token),
    enabled: Boolean(token),
  });

  async function update(id: string, changes: Partial<Pick<MemberProfile, 'status' | 'role'>>) {
    await adminFetch(`/members/${id}`, token, { method: 'PATCH', body: JSON.stringify(changes) });
    await client.invalidateQueries({ queryKey: ['admin-members'] });
  }

  return (
    <div className="space-y-3">
      {members.isLoading && <p>회원 목록을 불러오는 중입니다.</p>}
      {members.error && <p className="text-destructive">{members.error.message}</p>}
      {members.data?.members.map((member: MemberProfile) => (
        <article key={member.id} className="rounded-3xl border border-card-border bg-card p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-black">{member.display_name}</p>
              <p className="truncate text-xs text-muted-foreground">{member.login_name}</p>
            </div>
            <span className="shrink-0 rounded-full bg-secondary px-3 py-1 text-xs font-bold">
              {member.role === 'admin' ? '관리자' : member.role === 'member' ? '정회원' : '일반회원'}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <select
              aria-label={`${member.display_name} 상태`}
              value={member.status}
              onChange={(event) => void update(member.id, { status: event.target.value as MemberProfile['status'] })}
              className="min-w-0 rounded-xl border border-card-border bg-background p-2 text-sm font-bold"
            >
              <option value="pending">승인대기</option>
              <option value="approved">승인</option>
              <option value="rejected">반려</option>
              <option value="suspended">정지</option>
              <option value="withdrawn">탈퇴</option>
            </select>
            <select
              aria-label={`${member.display_name} 권한`}
              value={member.role}
              onChange={(event) => void update(member.id, { role: event.target.value as MemberProfile['role'] })}
              className="min-w-0 rounded-xl border border-card-border bg-background p-2 text-sm font-bold"
            >
              <option value="user">일반회원</option>
              <option value="member">정회원</option>
              <option value="admin">관리자</option>
            </select>
          </div>
        </article>
      ))}
    </div>
  );
}

function IconRepairPanel({ token }: { token: string }) {
  const client = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [backgroundColor, setBackgroundColor] = useState('#b91c1c');
  const [note, setNote] = useState('앱 아이콘 변경');
  const [message, setMessage] = useState('');
  const [approvalInputs, setApprovalInputs] = useState<Record<string, string>>({});

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const jobs = useQuery<IconJobsResponse>({
    queryKey: ['admin-icon-repair-jobs'],
    queryFn: () => adminFetch('/repair/icon/jobs', token),
    enabled: Boolean(token),
  });

  const createJob = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('먼저 아이콘 이미지를 선택해 주세요.');
      setMessage('아이콘 크기별 파일을 만들고 서버에 업로드하는 중입니다.');
      const variants = await generateIcons(file, backgroundColor);
      return adminFetch<{ ok: true; job: IconJob; message: string }>('/repair/icon/jobs', token, {
        method: 'POST',
        body: JSON.stringify({
          sourceName: file.name,
          note,
          backgroundColor,
          variants,
        }),
      });
    },
    onSuccess: async (result: { ok: true; job: IconJob; message: string }) => {
      setMessage(result.message);
      await client.invalidateQueries({ queryKey: ['admin-icon-repair-jobs'] });
    },
    onError: (error: Error) => setMessage(error instanceof Error ? error.message : '아이콘 작업 생성에 실패했습니다.'),
  });

  const applySource = useMutation({
    mutationFn: async (job: IconJob) => {
      const approvalPhrase = approvalInputs[job.id] ?? '';
      return adminFetch<{ ok: true; job: IconJob; message: string }>(
        `/repair/icon/jobs/${job.id}/apply-source`,
        token,
        { method: 'POST', body: JSON.stringify({ approvalPhrase }) },
      );
    },
    onSuccess: async (result: { ok: true; job: IconJob; message: string }) => {
      setMessage(result.message);
      await client.invalidateQueries({ queryKey: ['admin-icon-repair-jobs'] });
    },
    onError: (error: Error) => setMessage(error instanceof Error ? error.message : '소스 적용에 실패했습니다.'),
  });

  const rollback = useMutation({
    mutationFn: async (job: IconJob) => adminFetch<{ ok: true; job: IconJob; message: string }>(
      `/repair/icon/jobs/${job.id}/rollback`,
      token,
      { method: 'POST', body: JSON.stringify({ approvalPhrase: approvalInputs[job.id] ?? '' }) },
    ),
    onSuccess: async (result: { ok: true; job: IconJob; message: string }) => {
      setMessage(result.message);
      await client.invalidateQueries({ queryKey: ['admin-icon-repair-jobs'] });
    },
    onError: (error: Error) => setMessage(error instanceof Error ? error.message : '원복에 실패했습니다.'),
  });

  const busy = createJob.isPending || applySource.isPending || rollback.isPending;

  return (
    <div className="space-y-4">
      <section className="rounded-3xl border border-card-border bg-card p-4">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-primary/10 p-3 text-primary"><ImageIcon className="h-6 w-6" /></div>
          <div className="min-w-0">
            <h2 className="font-black">앱 아이콘 서버 작업</h2>
            <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">
              이미지를 필요한 크기로 만든 뒤 서버 작업공간에 올립니다. 소스 적용은 문구 승인 후 실행되며 빌드와 배포는 실행하지 않습니다.
            </p>
          </div>
        </div>

        <label className="mt-5 block cursor-pointer rounded-2xl border border-dashed border-card-border bg-background p-4 text-center">
          <Upload className="mx-auto h-6 w-6 text-primary" />
          <span className="mt-2 block text-sm font-black">PNG·JPG·WEBP 선택</span>
          <span className="mt-1 block text-xs text-muted-foreground">최대 8MB</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>

        {previewUrl && (
          <div className="mt-4 flex items-center gap-4 rounded-2xl bg-background p-3">
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl" style={{ backgroundColor }}>
              <img src={previewUrl} alt="선택한 아이콘 미리보기" className="h-full w-full object-contain p-1" />
            </div>
            <div className="min-w-0 text-left">
              <p className="truncate text-sm font-black">{file?.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {file ? `${Math.ceil(file.size / 1024).toLocaleString('ko-KR')}KB` : ''}
              </p>
            </div>
          </div>
        )}

        <div className="mt-4 grid grid-cols-[auto_1fr] items-center gap-3">
          <label htmlFor="icon-background" className="text-xs font-black">배경색</label>
          <div className="flex items-center gap-2">
            <input
              id="icon-background"
              type="color"
              value={backgroundColor}
              onChange={(event) => setBackgroundColor(event.target.value)}
              className="h-10 w-14 rounded-xl border border-card-border bg-background p-1"
            />
            <input
              value={backgroundColor}
              onChange={(event) => setBackgroundColor(event.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-card-border bg-background px-3 py-2 text-sm font-bold"
            />
          </div>
          <label htmlFor="icon-note" className="text-xs font-black">요청내용</label>
          <input
            id="icon-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="예: 119 로고로 앱 아이콘 변경"
            className="min-w-0 rounded-xl border border-card-border bg-background px-3 py-2 text-sm"
          />
        </div>

        <button
          type="button"
          disabled={!file || busy}
          onClick={() => createJob.mutate()}
          className="mt-4 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createJob.isPending ? '서버에 업로드 중…' : '서버에 올리고 작업 생성'}
        </button>
      </section>

      {message && <p className="rounded-2xl border border-card-border bg-card p-3 text-sm font-bold">{message}</p>}

      <section className="rounded-3xl border border-card-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-black">아이콘 작업 기록</h2>
            <p className="mt-1 text-xs text-muted-foreground">최근 작업 최대 50개</p>
          </div>
          <button type="button" aria-label="아이콘 작업 새로고침" onClick={() => void jobs.refetch()}>
            <RefreshCw className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {jobs.isLoading && <p className="text-sm text-muted-foreground">작업 기록을 불러오는 중입니다.</p>}
          {jobs.error && <p className="text-sm text-destructive">{jobs.error.message}</p>}
          {!jobs.isLoading && !jobs.data?.jobs.length && (
            <p className="rounded-2xl bg-background p-4 text-sm text-muted-foreground">아직 아이콘 작업이 없습니다.</p>
          )}
          {jobs.data?.jobs.map((job: IconJob) => {
            const isApply = job.status === 'staged_awaiting_approval';
            const isRollback = job.status === 'source_applied_build_pending' || job.status === 'failed';
            const expectedPhrase = isApply ? '아이콘 소스 적용' : '아이콘 원복';
            return (
              <article key={job.id} className="rounded-2xl border border-card-border bg-background p-4 text-left">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-black">{job.sourceName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(job.createdAt).toLocaleString('ko-KR')} · {job.createdByName}
                    </p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-[11px] font-black ${statusClass(job.status)}`}>
                    {statusText(job.status)}
                  </span>
                </div>

                {job.note && <p className="mt-3 break-keep text-sm">{job.note}</p>}
                <div className="mt-3 rounded-xl bg-card p-3 text-xs text-muted-foreground">
                  <p className="font-bold text-foreground">변경 파일 {job.files.length}개</p>
                  {job.files.map((item: IconJobFile) => (
                    <p key={item.targetRelativePath} className="mt-1 truncate">
                      {item.width}×{item.height} · {item.targetRelativePath}
                    </p>
                  ))}
                </div>

                {job.status === 'source_applied_build_pending' && (
                  <div className="mt-3 rounded-xl bg-amber-500/10 p-3 text-xs font-bold text-amber-800 dark:text-amber-200">
                    <Clock3 className="mr-1 inline h-4 w-4" />
                    소스까지만 바뀌었습니다. 빌드 명령은 실행되지 않았습니다: {job.buildCommand}
                  </div>
                )}
                {job.status === 'rolled_back' && (
                  <p className="mt-3 rounded-xl bg-positive/10 p-3 text-xs font-bold text-positive">
                    <CheckCircle2 className="mr-1 inline h-4 w-4" />변경 전 아이콘으로 원복됐습니다.
                  </p>
                )}
                {job.error && <p className="mt-3 rounded-xl bg-destructive/10 p-3 text-xs font-bold text-destructive">{job.error}</p>}

                {(isApply || isRollback) && (
                  <div className="mt-3">
                    <p className="mb-2 text-xs font-bold text-muted-foreground">
                      아래 문구 입력: <strong className="text-foreground">{expectedPhrase}</strong>
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        value={approvalInputs[job.id] ?? ''}
                        onChange={(event) => setApprovalInputs((current) => ({ ...current, [job.id]: event.target.value }))}
                        placeholder={expectedPhrase}
                        className="min-w-0 flex-1 rounded-xl border border-card-border bg-card px-3 py-2 text-sm font-bold"
                      />
                      {isApply ? (
                        <button
                          type="button"
                          disabled={busy || approvalInputs[job.id] !== expectedPhrase}
                          onClick={() => applySource.mutate(job)}
                          className="rounded-xl bg-primary px-4 py-2 text-sm font-black text-primary-foreground disabled:opacity-40"
                        >
                          소스 적용 · 빌드 전 멈춤
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || approvalInputs[job.id] !== expectedPhrase}
                          onClick={() => rollback.mutate(job)}
                          className="rounded-xl bg-destructive px-4 py-2 text-sm font-black text-destructive-foreground disabled:opacity-40"
                        >
                          <RotateCcw className="mr-1 inline h-4 w-4" />원복
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default function AdminPage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const token = auth.session?.access_token ?? '';
  const [tab, setTab] = useState<AdminTab>('repair');

  if (!auth.isAdmin) {
    return (
      <div className="p-6">
        <ShieldAlert className="h-10 w-10 text-destructive" />
        <h1 className="mt-4 text-xl font-black">관리자 권한이 필요합니다.</h1>
        <button onClick={() => navigate('/account')} className="mt-5 rounded-2xl bg-primary px-4 py-3 font-bold text-primary-foreground">
          계정으로 돌아가기
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background pb-12">
      <header className="sticky top-0 z-30 border-b border-card-border bg-background/95 px-4 py-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <button aria-label="뒤로 가기" onClick={() => navigate('/account')}><ArrowLeft /></button>
          <div className="flex-1 text-left">
            <h1 className="text-xl font-black">관리자 관리센터</h1>
            <p className="text-xs text-muted-foreground">회원 관리와 승인형 AI 복구 작업</p>
          </div>
          <Wrench className="h-5 w-5 text-primary" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl bg-secondary p-1">
          <button
            type="button"
            onClick={() => setTab('repair')}
            className={`rounded-xl px-3 py-2 text-sm font-black ${tab === 'repair' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}
          >
            <Wrench className="mr-1 inline h-4 w-4" />AI 복구 기사
          </button>
          <button
            type="button"
            onClick={() => setTab('members')}
            className={`rounded-xl px-3 py-2 text-sm font-black ${tab === 'members' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}
          >
            <Users className="mr-1 inline h-4 w-4" />회원 관리
          </button>
        </div>
      </header>
      <main className="p-4">
        {tab === 'repair' ? <IconRepairPanel token={token} /> : <MembersPanel token={token} />}
      </main>
    </div>
  );
}
