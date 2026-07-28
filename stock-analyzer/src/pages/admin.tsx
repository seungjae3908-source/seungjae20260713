import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  History,
  RefreshCw,
  Search,
  ShieldAlert,
  Users,
} from 'lucide-react';
import {
  useAuth,
  type MemberProfile,
} from '@/lib/auth';

type MemberStatus = MemberProfile['status'];
type MemberRole = MemberProfile['role'];
type AdminTab = 'members' | 'audit';

type AdminMember = MemberProfile & { masked_email?: string | null };

type MembersResponse = {
  members: AdminMember[];
};

type AuditLogRow = {
  id?: string;
  actor_id?: string | null;
  action?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  details?: unknown;
  ip_address?: string | null;
  created_at?: string | null;
};

type AuditLogsResponse = {
  logs: AuditLogRow[];
};

const PAGE_SIZE = 10;

const STATUS_OPTIONS: Array<{
  value: MemberStatus;
  label: string;
}> = [
  { value: 'pending', label: '승인대기' },
  { value: 'approved', label: '승인' },
  { value: 'rejected', label: '반려' },
  { value: 'suspended', label: '정지' },
  { value: 'withdrawn', label: '탈퇴' },
];

const ROLE_OPTIONS: Array<{
  value: MemberRole;
  label: string;
}> = [
  { value: 'associate', label: '준회원' },
  { value: 'full', label: '정회원' },
  { value: 'admin', label: '관리자' },
];

async function adminFetch<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      data &&
      typeof data === 'object' &&
      'error' in data
        ? String(data.error)
        : `관리자 요청 실패 (${response.status})`;

    if (message === 'CANNOT_REMOVE_LAST_ADMIN') {
      throw new Error('마지막 관리자는 강등하거나 정지할 수 없습니다. 먼저 다른 관리자를 지정해 주세요.');
    }
    if (message === 'CANNOT_REMOVE_OWN_ADMIN_ACCESS') {
      throw new Error('본인의 관리자 권한은 스스로 해제할 수 없습니다.');
    }
    throw new Error(message);
  }

  return data as T;
}

function getStatusLabel(status: MemberStatus | string): string {
  return (
    STATUS_OPTIONS.find((option) => option.value === status)?.label ??
    String(status)
  );
}

function getRoleLabel(role: MemberRole | string): string {
  if (role === 'admin') return '관리자';
  if (role === 'associate') return '준회원';
  if (role === 'full' || role === 'user') return '정회원';
  return String(role);
}

function formatDateTime(value?: string | null): string {
  if (!value) return '시간 기록 없음';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function shortId(value?: string | null): string {
  if (!value) return '기록 없음';
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('ko-KR');
}

function parseAuditDetails(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);

      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { message: value };
    }
  }

  return {};
}

function formatAuditChanges(details: unknown): string[] {
  const parsed = parseAuditDetails(details);
  const rows: string[] = [];

  if (typeof parsed.status === 'string') {
    rows.push(`승인 상태 → ${getStatusLabel(parsed.status)}`);
  }

  if (typeof parsed.role === 'string') {
    rows.push(`회원 권한 → ${getRoleLabel(parsed.role)}`);
  }

  if (
    typeof parsed.message === 'string' &&
    parsed.message.trim()
  ) {
    rows.push(parsed.message.trim());
  }

  const excludedKeys = new Set([
    'status',
    'role',
    'message',
    'updated_at',
    'approved_at',
    'approved_by',
  ]);

  for (const [key, rawValue] of Object.entries(parsed)) {
    if (excludedKeys.has(key) || rawValue == null) {
      continue;
    }

    const text =
      typeof rawValue === 'object'
        ? JSON.stringify(rawValue)
        : String(rawValue);

    rows.push(`${key} → ${text}`);
  }

  if (rows.length === 0) {
    rows.push('변경 상세정보 없음');
  }

  return rows;
}

function MemberSelect<T extends string>({
  ariaLabel,
  value,
  options,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  value: T;
  options: Array<{
    value: T;
    label: string;
  }>;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className="
        h-12
        w-full
        rounded-2xl
        border
        border-card-border
        bg-background
        px-4
        text-sm
        font-black
        text-foreground
        outline-none
        transition
        focus:border-primary
        focus:ring-2
        focus:ring-primary/20
        disabled:cursor-not-allowed
        disabled:opacity-60
      "
    >
      {options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          style={{
            color: '#111827',
            backgroundColor: '#ffffff',
          }}
        >
          {option.label}
        </option>
      ))}
    </select>
  );
}

function Pagination({
  page,
  totalPages,
  totalItems,
  label,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  label: string;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) {
    return (
      <p className="px-4 py-3 text-center text-xs font-bold text-muted-foreground">
        총 {totalItems}{label}
      </p>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="
            flex
            h-10
            items-center
            justify-center
            gap-1
            rounded-xl
            border
            border-card-border
            bg-background
            px-3
            text-xs
            font-black
            disabled:cursor-not-allowed
            disabled:opacity-40
          "
        >
          <ChevronLeft className="h-4 w-4" />
          이전
        </button>

        <div className="text-center">
          <p className="text-sm font-black">
            {page} / {totalPages} 페이지
          </p>

          <p className="mt-1 text-[11px] font-bold text-muted-foreground">
            총 {totalItems}{label}
          </p>
        </div>

        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="
            flex
            h-10
            items-center
            justify-center
            gap-1
            rounded-xl
            border
            border-card-border
            bg-background
            px-3
            text-xs
            font-black
            disabled:cursor-not-allowed
            disabled:opacity-40
          "
        >
          다음
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const [, navigate] = useLocation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const token = auth.session?.access_token ?? '';

  const [activeTab, setActiveTab] = useState<AdminTab>('members');
  const [memberSearch, setMemberSearch] = useState('');
  const [auditSearch, setAuditSearch] = useState('');
  const [memberPage, setMemberPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [savingMemberId, setSavingMemberId] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState('');
  const [openMemberId, setOpenMemberId] = useState<string | null>(null);
  const [openAuditId, setOpenAuditId] = useState<string | null>(null);

  const membersQuery = useQuery<MembersResponse>({
    queryKey: ['admin-members'],
    queryFn: () => adminFetch<MembersResponse>('/members', token),
    enabled: auth.isAdmin && Boolean(token),
  });

  const auditLogsQuery = useQuery<AuditLogsResponse>({
    queryKey: ['admin-audit-logs'],
    queryFn: () => adminFetch<AuditLogsResponse>('/audit-logs', token),
    enabled: auth.isAdmin && Boolean(token),
  });

  const members = membersQuery.data?.members ?? [];
  const auditLogs = auditLogsQuery.data?.logs ?? [];

  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();

    for (const member of members) {
      const name =
        member.display_name ||
        member.login_name ||
        shortId(member.id);

      map.set(member.id, name);
    }

    const currentProfileId = (
      auth.profile as
        | {
            id?: string;
          }
        | null
        | undefined
    )?.id;

    if (currentProfileId) {
      map.set(
        currentProfileId,
        auth.displayName || '현재 관리자',
      );
    }

    return map;
  }, [members, auth.profile, auth.displayName]);

  const filteredMembers = useMemo(() => {
    const keyword = normalizeText(memberSearch);

    if (!keyword) {
      return members;
    }

    return members.filter((member) => {
      const searchable = [
        member.display_name,
        member.login_name,
        member.id,
        getStatusLabel(member.status),
        getRoleLabel(member.role),
      ]
        .map(normalizeText)
        .join(' ');

      return searchable.includes(keyword);
    });
  }, [members, memberSearch]);

  const filteredAuditLogs = useMemo(() => {
    const keyword = normalizeText(auditSearch);

    if (!keyword) {
      return auditLogs;
    }

    return auditLogs.filter((log) => {
      const actorName = log.actor_id
        ? memberNameById.get(log.actor_id) ?? shortId(log.actor_id)
        : '관리자 정보 없음';

      const targetName = log.target_id
        ? memberNameById.get(log.target_id) ?? shortId(log.target_id)
        : '대상 정보 없음';

      const changes = formatAuditChanges(log.details);

      const searchable = [
        actorName,
        targetName,
        log.actor_id,
        log.target_id,
        log.action,
        log.target_type,
        log.ip_address,
        log.created_at,
        formatDateTime(log.created_at),
        ...changes,
      ]
        .map(normalizeText)
        .join(' ');

      return searchable.includes(keyword);
    });
  }, [auditLogs, auditSearch, memberNameById]);

  const memberTotalPages = Math.max(
    1,
    Math.ceil(filteredMembers.length / PAGE_SIZE),
  );

  const auditTotalPages = Math.max(
    1,
    Math.ceil(filteredAuditLogs.length / PAGE_SIZE),
  );

  const safeMemberPage = Math.min(memberPage, memberTotalPages);
  const safeAuditPage = Math.min(auditPage, auditTotalPages);

  const visibleMembers = filteredMembers.slice(
    (safeMemberPage - 1) * PAGE_SIZE,
    safeMemberPage * PAGE_SIZE,
  );

  const visibleAuditLogs = filteredAuditLogs.slice(
    (safeAuditPage - 1) * PAGE_SIZE,
    safeAuditPage * PAGE_SIZE,
  );

  useEffect(() => {
    if (memberPage > memberTotalPages) {
      setMemberPage(memberTotalPages);
    }
  }, [memberPage, memberTotalPages]);

  useEffect(() => {
    if (auditPage > auditTotalPages) {
      setAuditPage(auditTotalPages);
    }
  }, [auditPage, auditTotalPages]);

  async function refreshAll() {
    await Promise.all([
      membersQuery.refetch(),
      auditLogsQuery.refetch(),
    ]);
  }

  async function updateMember(
    memberId: string,
    changes: Partial<
      Pick<MemberProfile, 'status' | 'role'>
    >,
  ) {
    // 관리자 승격은 되돌리기 어려운 변경이라 한 번 더 확인한다.
    if (changes.role === 'admin') {
      const confirmed = window.confirm('이 회원에게 관리자 권한을 부여할까요? 관리자는 모든 회원 정보와 설정을 변경할 수 있습니다.');
      if (!confirmed) return;
    }

    setSavingMemberId(memberId);
    setNotice('');

    try {
      await adminFetch(`/members/${memberId}`, token, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['admin-members'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['admin-audit-logs'],
        }),
      ]);

      setNotice('회원 정보가 변경되었습니다.');
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : '회원 정보 변경에 실패했습니다.',
      );
    } finally {
      setSavingMemberId(null);
    }
  }

  function toggleMember(memberId: string) {
    setOpenMemberId((current) =>
      current === memberId ? null : memberId,
    );
  }

  function toggleAudit(auditId: string) {
    setOpenAuditId((current) =>
      current === auditId ? null : auditId,
    );
  }

  function openTab(tab: AdminTab) {
    setActiveTab(tab);
    setNotice('');
    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }

  if (auth.loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6">
        <p className="text-sm font-black text-muted-foreground">
          관리자 권한을 확인하고 있습니다.
        </p>
      </div>
    );
  }

  if (!auth.isAdmin) {
    return (
      <div className="h-full overflow-y-auto bg-background p-6">
        <ShieldAlert className="h-10 w-10 text-destructive" />

        <h1 className="mt-4 text-xl font-black">
          관리자 권한이 필요합니다.
        </h1>

        <button
          type="button"
          onClick={() => navigate('/account')}
          className="
            mt-5
            rounded-2xl
            bg-primary
            px-4
            py-3
            font-black
            text-primary-foreground
          "
        >
          계정으로 돌아가기
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background pb-12">
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-4 py-4 backdrop-blur">
        <div className="mx-auto grid w-full max-w-2xl grid-cols-[44px_1fr_44px] items-center gap-3">
          <button
            type="button"
            aria-label="뒤로 가기"
            onClick={() => navigate('/account')}
            className="
              flex
              h-11
              w-11
              items-center
              justify-center
              rounded-full
              transition
              hover:bg-secondary
            "
          >
            <ArrowLeft className="h-6 w-6" />
          </button>

          <div className="min-w-0 text-left">
            <h1 className="text-xl font-black">
              회원 관리
            </h1>

            <p className="mt-1 text-xs font-bold text-muted-foreground">
              회원과 감사기록을 탭으로 나누어 관리합니다.
            </p>
          </div>

          <button
            type="button"
            aria-label="전체 새로고침"
            disabled={
              membersQuery.isFetching ||
              auditLogsQuery.isFetching
            }
            onClick={() => void refreshAll()}
            className="
              flex
              h-11
              w-11
              items-center
              justify-center
              rounded-full
              transition
              hover:bg-secondary
              disabled:opacity-50
            "
          >
            <RefreshCw
              className={`h-5 w-5 ${
                membersQuery.isFetching ||
                auditLogsQuery.isFetching
                  ? 'animate-spin'
                  : ''
              }`}
            />
          </button>
        </div>

        <div className="mx-auto mt-4 grid w-full max-w-2xl grid-cols-2 gap-2 rounded-2xl bg-secondary p-1.5">
          <button
            type="button"
            onClick={() => openTab('members')}
            className={`
              flex
              items-center
              justify-center
              gap-2
              rounded-xl
              px-3
              py-3
              text-sm
              font-black
              transition
              ${
                activeTab === 'members'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground'
              }
            `}
          >
            <Users className="h-4 w-4" />
            회원목록
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px]">
              {members.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => openTab('audit')}
            className={`
              flex
              items-center
              justify-center
              gap-2
              rounded-xl
              px-3
              py-3
              text-sm
              font-black
              transition
              ${
                activeTab === 'audit'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground'
              }
            `}
          >
            <History className="h-4 w-4" />
            감사기록
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px]">
              {auditLogs.length}
            </span>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl space-y-4 p-4">
        {notice && (
          <p className="rounded-2xl border border-card-border bg-card px-4 py-3 text-center text-sm font-black">
            {notice}
          </p>
        )}

        {activeTab === 'members' && (
          <section>
            <div
              className="
                overflow-hidden
                rounded-3xl
                border
                border-card-border
                bg-card
                shadow-sm
              "
            >
              <div className="border-b border-card-border p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-base font-black">
                      회원목록
                    </p>

                    <p className="mt-1 text-xs font-bold text-muted-foreground">
                      회원 전체가 한 칸 안에 표시됩니다.
                    </p>
                  </div>

                  <span className="rounded-full bg-secondary px-3 py-1.5 text-xs font-black">
                    {filteredMembers.length}명
                  </span>
                </div>

                <label className="relative block">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />

                  <input
                    value={memberSearch}
                    onChange={(event) => {
                      setMemberSearch(event.target.value);
                      setMemberPage(1);
                    }}
                    placeholder="이름, 아이디, 상태, 권한 검색"
                    className="
                      h-12
                      w-full
                      rounded-2xl
                      border
                      border-card-border
                      bg-background
                      pl-11
                      pr-4
                      text-sm
                      font-bold
                      outline-none
                      placeholder:text-muted-foreground
                      focus:border-primary
                      focus:ring-2
                      focus:ring-primary/20
                    "
                  />
                </label>

                <div className="mt-3 flex items-center justify-between gap-3 text-[11px] font-bold text-muted-foreground">
                  <span>
                    검색 결과 {filteredMembers.length}명
                  </span>

                  <span>
                    회원을 누르면 상세 표시
                  </span>
                </div>
              </div>

              {membersQuery.isLoading && (
                <p className="p-6 text-center text-sm font-black text-muted-foreground">
                  회원 목록을 불러오는 중입니다.
                </p>
              )}

              {membersQuery.error && (
                <p className="bg-destructive/10 p-6 text-center text-sm font-black text-destructive">
                  {membersQuery.error instanceof Error
                    ? membersQuery.error.message
                    : '회원 목록을 불러오지 못했습니다.'}
                </p>
              )}

              {!membersQuery.isLoading &&
                !membersQuery.error &&
                filteredMembers.length === 0 && (
                  <p className="p-6 text-center text-sm font-black text-muted-foreground">
                    검색 조건에 맞는 회원이 없습니다.
                  </p>
                )}

              {!membersQuery.isLoading &&
                !membersQuery.error &&
                visibleMembers.length > 0 && (
                  <div>
                    {visibleMembers.map((member, index) => {
                      const isSaving = savingMemberId === member.id;
                      const isOpen = openMemberId === member.id;
                      const displayName =
                        member.display_name ||
                        member.login_name ||
                        '이름 없음';
                      const isLast = index === visibleMembers.length - 1;

                      return (
                        <article
                          key={member.id}
                          className={
                            isLast
                              ? 'overflow-hidden'
                              : 'overflow-hidden border-b border-card-border'
                          }
                        >
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => toggleMember(member.id)}
                            className="
                              grid
                              w-full
                              grid-cols-[minmax(0,1fr)_auto_auto_auto]
                              items-center
                              gap-2
                              px-4
                              py-4
                              text-left
                              transition
                              hover:bg-secondary/40
                            "
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-black">
                                {displayName}
                              </p>

                              <p className="mt-0.5 truncate text-[11px] font-bold text-muted-foreground">
                                {member.login_name || '아이디 없음'}
                                {member.masked_email ? ` · ${member.masked_email}` : ''}
                              </p>
                            </div>

                            <span className="shrink-0 rounded-full bg-secondary px-2.5 py-1 text-[10px] font-black text-foreground">
                              {getStatusLabel(member.status)}
                            </span>

                            <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-black text-primary">
                              {getRoleLabel(member.role)}
                            </span>

                            {isOpen ? (
                              <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                            )}
                          </button>

                          {isOpen && (
                            <div className="border-t border-card-border bg-background/60 px-4 pb-4 pt-3">
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <p className="mb-2 px-1 text-xs font-black text-muted-foreground">
                                    승인 상태
                                  </p>

                                  <MemberSelect
                                    ariaLabel={`${displayName} 승인 상태`}
                                    value={member.status}
                                    options={STATUS_OPTIONS}
                                    disabled={isSaving}
                                    onChange={(status) => {
                                      // 신규(대기) 회원 승인 시 기본 등급은 준회원입니다.
                                      // 등급은 승인 후 옆의 회원 권한에서 변경할 수 있습니다.
                                      const changes: Partial<Pick<MemberProfile, 'status' | 'role'>> =
                                        status === 'approved' && member.status === 'pending' && member.role !== 'admin'
                                          ? { status, role: 'associate' }
                                          : { status };
                                      void updateMember(member.id, changes);
                                    }}
                                  />
                                </div>

                                <div>
                                  <p className="mb-2 px-1 text-xs font-black text-muted-foreground">
                                    회원 권한
                                  </p>

                                  <MemberSelect
                                    ariaLabel={`${displayName} 회원 권한`}
                                    value={member.role}
                                    options={ROLE_OPTIONS}
                                    disabled={isSaving}
                                    onChange={(role) =>
                                      void updateMember(member.id, { role })
                                    }
                                  />
                                </div>
                              </div>

                              <div className="mt-3 rounded-xl border border-card-border bg-card px-3 py-2 text-xs">
                                <div className="grid grid-cols-[72px_1fr] gap-2">
                                  <span className="font-black text-muted-foreground">
                                    회원 이름
                                  </span>

                                  <span className="min-w-0 break-all font-black">
                                    {displayName}
                                  </span>
                                </div>

                                <div className="mt-2 grid grid-cols-[72px_1fr] gap-2">
                                  <span className="font-black text-muted-foreground">
                                    로그인 ID
                                  </span>

                                  <span className="min-w-0 break-all font-black">
                                    {member.login_name || '아이디 없음'}
                                  </span>
                                </div>

                                <div className="mt-2 grid grid-cols-[72px_1fr] gap-2">
                                  <span className="font-black text-muted-foreground">
                                    회원 UUID
                                  </span>

                                  <span className="min-w-0 break-all font-bold text-muted-foreground">
                                    {member.id}
                                  </span>
                                </div>
                              </div>

                              {isSaving && (
                                <p className="mt-3 text-center text-xs font-black text-primary">
                                  변경 내용을 저장하고 있습니다.
                                </p>
                              )}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}

              {!membersQuery.isLoading &&
                !membersQuery.error &&
                filteredMembers.length > 0 && (
                  <div className="border-t border-card-border">
                    <Pagination
                      page={safeMemberPage}
                      totalPages={memberTotalPages}
                      totalItems={filteredMembers.length}
                      label="명"
                      onPageChange={setMemberPage}
                    />
                  </div>
                )}
            </div>
          </section>
        )}

        {activeTab === 'audit' && (
          <section>
            <div
              className="
                overflow-hidden
                rounded-3xl
                border
                border-card-border
                bg-card
                shadow-sm
              "
            >
              <div className="border-b border-card-border p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-base font-black">
                      감사기록 목록
                    </p>

                    <p className="mt-1 text-xs font-bold text-muted-foreground">
                      모든 감사기록이 한 칸 안에 표시됩니다.
                    </p>
                  </div>

                  <span className="rounded-full bg-secondary px-3 py-1.5 text-xs font-black">
                    {filteredAuditLogs.length}건
                  </span>
                </div>

                <label className="relative block">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />

                  <input
                    value={auditSearch}
                    onChange={(event) => {
                      setAuditSearch(event.target.value);
                      setAuditPage(1);
                    }}
                    placeholder="관리자, 회원, 변경내용, IP 검색"
                    className="
                      h-12
                      w-full
                      rounded-2xl
                      border
                      border-card-border
                      bg-background
                      pl-11
                      pr-4
                      text-sm
                      font-bold
                      outline-none
                      placeholder:text-muted-foreground
                      focus:border-primary
                      focus:ring-2
                      focus:ring-primary/20
                    "
                  />
                </label>

                <div className="mt-3 flex items-center justify-between gap-3 text-[11px] font-bold text-muted-foreground">
                  <span>
                    검색 결과 {filteredAuditLogs.length}건
                  </span>

                  <span>
                    기록을 누르면 상세 표시
                  </span>
                </div>
              </div>

              {auditLogsQuery.isLoading && (
                <p className="p-6 text-center text-sm font-black text-muted-foreground">
                  감사기록을 불러오는 중입니다.
                </p>
              )}

              {auditLogsQuery.error && (
                <p className="bg-destructive/10 p-6 text-center text-sm font-black text-destructive">
                  {auditLogsQuery.error instanceof Error
                    ? auditLogsQuery.error.message
                    : '감사기록을 불러오지 못했습니다.'}
                </p>
              )}

              {!auditLogsQuery.isLoading &&
                !auditLogsQuery.error &&
                filteredAuditLogs.length === 0 && (
                  <p className="p-6 text-center text-sm font-black text-muted-foreground">
                    검색 조건에 맞는 감사기록이 없습니다.
                  </p>
                )}

              {!auditLogsQuery.isLoading &&
                !auditLogsQuery.error &&
                visibleAuditLogs.length > 0 && (
                  <div>
                    {visibleAuditLogs.map((log, index) => {
                      const auditId =
                        log.id ??
                        `${log.created_at ?? 'audit'}-${safeAuditPage}-${index}`;
                      const isOpen = openAuditId === auditId;

                      const actorName = log.actor_id
                        ? memberNameById.get(log.actor_id) ??
                          shortId(log.actor_id)
                        : '관리자 정보 없음';

                      const targetName = log.target_id
                        ? memberNameById.get(log.target_id) ??
                          shortId(log.target_id)
                        : '대상 정보 없음';

                      const changes = formatAuditChanges(log.details);
                      const summary =
                        changes[0] || '변경 상세정보 없음';
                      const isLast =
                        index === visibleAuditLogs.length - 1;

                      return (
                        <article
                          key={auditId}
                          className={
                            isLast
                              ? 'overflow-hidden'
                              : 'overflow-hidden border-b border-card-border'
                          }
                        >
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => toggleAudit(auditId)}
                            className="
                              grid
                              w-full
                              grid-cols-[minmax(0,1fr)_auto_auto]
                              items-center
                              gap-2
                              px-4
                              py-4
                              text-left
                              transition
                              hover:bg-secondary/40
                            "
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-black">
                                {targetName}
                              </p>

                              <p className="mt-0.5 truncate text-[11px] font-bold text-muted-foreground">
                                {summary} · {formatDateTime(log.created_at)}
                              </p>
                            </div>

                            <span className="max-w-[110px] truncate rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-black text-primary">
                              {log.action || 'member.update'}
                            </span>

                            {isOpen ? (
                              <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                            )}
                          </button>

                          {isOpen && (
                            <div className="border-t border-card-border bg-background/60 px-4 pb-4 pt-3">
                              <div className="space-y-2 rounded-2xl border border-card-border bg-card p-4">
                                <div className="grid grid-cols-[74px_1fr] gap-2 text-xs">
                                  <span className="font-black text-muted-foreground">
                                    관리자
                                  </span>

                                  <span className="min-w-0 break-all font-black">
                                    {actorName}
                                  </span>
                                </div>

                                <div className="grid grid-cols-[74px_1fr] gap-2 text-xs">
                                  <span className="font-black text-muted-foreground">
                                    대상 회원
                                  </span>

                                  <span className="min-w-0 break-all font-black">
                                    {targetName}
                                  </span>
                                </div>

                                <div className="grid grid-cols-[74px_1fr] gap-2 text-xs">
                                  <span className="font-black text-muted-foreground">
                                    변경 시간
                                  </span>

                                  <span className="min-w-0 break-all font-black">
                                    {formatDateTime(log.created_at)}
                                  </span>
                                </div>

                                <div className="grid grid-cols-[74px_1fr] gap-2 text-xs">
                                  <span className="font-black text-muted-foreground">
                                    변경 내용
                                  </span>

                                  <div className="min-w-0 space-y-1">
                                    {changes.map((change, changeIndex) => (
                                      <p
                                        key={`${change}-${changeIndex}`}
                                        className="break-words font-black"
                                      >
                                        {change}
                                      </p>
                                    ))}
                                  </div>
                                </div>

                                <div className="grid grid-cols-[74px_1fr] gap-2 text-xs">
                                  <span className="font-black text-muted-foreground">
                                    접속 IP
                                  </span>

                                  <span className="min-w-0 break-all font-black">
                                    {log.ip_address || 'IP 기록 없음'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}

              {!auditLogsQuery.isLoading &&
                !auditLogsQuery.error &&
                filteredAuditLogs.length > 0 && (
                  <div className="border-t border-card-border">
                    <Pagination
                      page={safeAuditPage}
                      totalPages={auditTotalPages}
                      totalItems={filteredAuditLogs.length}
                      label="건"
                      onPageChange={setAuditPage}
                    />
                  </div>
                )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
