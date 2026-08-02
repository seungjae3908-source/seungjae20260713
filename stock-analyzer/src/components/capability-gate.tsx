import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useLocation } from 'wouter';
import { useAuth } from '@/lib/auth';
import { MEMBER_TIER_LABELS, type MemberCapability } from '../../../packages/member-access/src/index.js';

const CAPABILITY_LABELS: Record<MemberCapability, string> = {
  canAccessBasicInfo: '기본 정보',
  canAccessSpot: '코인 현물',
  canAccessFutures: '코인 선물',
  canAccessRiskPreview: '리스크 미리보기',
  canAccessBacktests: '백테스트',
  canAccessPaperTrading: '모의매매',
  canAccessJournalSync: '거래일지 동기화',
  canAccessTradingAnalytics: '거래 분석',
  canAccessAiTradingReview: 'AI 거래 복기',
  canManageMembers: '회원 관리',
};

export function CapabilityGate({ capability, children }: { capability: MemberCapability; children: ReactNode }) {
  const auth = useAuth();
  const [, navigate] = useLocation();

  if (auth.loading) return null;
  if (auth.can(capability)) return <>{children}</>;

  return (
    <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background p-5" data-testid="capability-denied">
      <section className="w-full max-w-sm rounded-3xl border border-card-border bg-card p-6 text-center shadow-sm">
        <ShieldAlert className="mx-auto h-11 w-11 text-warning" />
        <h1 className="mt-4 text-xl font-black">이 기능을 사용할 수 없습니다.</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          현재 등급은 <strong>{MEMBER_TIER_LABELS[auth.membershipLevel]}</strong>이며,
          <br /><strong>{CAPABILITY_LABELS[capability]}</strong> 권한이 필요합니다.
        </p>
        <button
          type="button"
          onClick={() => navigate('/account', { replace: true })}
          className="mt-5 w-full rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground"
        >
          계정 상태 확인
        </button>
      </section>
    </main>
  );
}
