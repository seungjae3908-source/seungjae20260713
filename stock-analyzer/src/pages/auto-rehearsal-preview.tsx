import { CenteredPageHeader } from '@/components/centered-page-header';
import { FormulaAiAutoRehearsalPanel } from '@/components/formula-ai-auto-rehearsal-panel';

export default function AutoRehearsalPreviewPage() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground" data-testid="auto-rehearsal-preview-page">
      <CenteredPageHeader title="자동매매 리허설 Preview" />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4">
        <div className="mx-auto w-full max-w-3xl space-y-3">
          <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs leading-5 text-muted-foreground">
            이 화면은 PR 격리 Preview 전용입니다. 회원승인, 실계정 Provider, 저장 Credential, Telegram 실제 전송, 운영 데이터는 사용하지 않습니다.
            LIVE/AUTO/실주문 권한은 항상 OFF이며 실제 주문은 0건입니다.
          </section>
          <FormulaAiAutoRehearsalPanel isolatedPreview />
        </div>
      </main>
    </div>
  );
}
