import { useState } from 'react';
import { hasCapability, type MemberTier } from '../../../packages/member-access/src/index.js';
import Phase12TradeAutomationE2EPage from '@/pages/phase12-trade-automation-e2e';

type SessionState = { loggedIn: boolean; tier: MemberTier };

export default function Phase12TradeAutomationAccessE2EPage() {
  const [session, setSession] = useState<SessionState>({ loggedIn: true, tier: 'regular' });
  const administrator = session.loggedIn && hasCapability(session.tier, 'canManageMembers');

  return (
    <div className="h-[100dvh] overflow-hidden bg-background" data-testid="phase12-access-fixture">
      <div className="border-b border-card-border bg-card p-3">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSession({ loggedIn: true, tier: 'regular' })}
            className="rounded-xl border border-card-border px-3 py-2 text-xs font-extrabold"
          >
            정회원 로그인
          </button>
          <button
            type="button"
            onClick={() => setSession({ loggedIn: true, tier: 'admin' })}
            className="rounded-xl border border-card-border px-3 py-2 text-xs font-extrabold"
          >
            관리자 재로그인
          </button>
          <button
            type="button"
            onClick={() => setSession((current) => ({ ...current, loggedIn: false }))}
            className="rounded-xl border border-card-border px-3 py-2 text-xs font-extrabold"
          >
            로그아웃
          </button>
          <span data-testid="phase12-session-state" className="text-xs font-bold">
            {session.loggedIn ? session.tier : 'logged-out'}
          </span>
          <div data-testid="phase12-technical-menu" className="ml-auto text-xs font-black">
            {administrator ? <span>자동매매</span> : <span>AI 검색기 · AI 차트 분석기</span>}
          </div>
        </div>
      </div>

      {administrator ? (
        <div className="h-[calc(100dvh-65px)]" data-testid="phase12-admin-auto-trading-surface">
          <Phase12TradeAutomationE2EPage />
        </div>
      ) : (
        <main
          className="flex h-[calc(100dvh-65px)] items-center justify-center p-4 text-center"
          data-testid="phase12-auto-trading-denied"
        >
          <div>
            <h1 className="text-lg font-black">자동매매 관리자 전용</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              정회원과 로그아웃 사용자는 자동매매 메뉴·페이지·설정·승인 queue·복구 UI를 생성하지 않습니다.
            </p>
          </div>
        </main>
      )}
    </div>
  );
}
