import { useLocation, useSearch } from 'wouter';
import {
  ArrowLeft,
  BarChart3,
  BrainCircuit,
  ChevronRight,
  Database,
  Gauge,
  MessageCircle,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { CenteredPageHeader } from '@/components/centered-page-header';
import { useSettings, type AiVerbosity, type ScannerMode, type ThemeMode } from '@/lib/settings';
import { cn } from '@/lib/utils';

type SettingsSectionId =
  | 'account'
  | 'market'
  | 'risk'
  | 'scanner'
  | 'telegram'
  | 'ai'
  | 'display'
  | 'provider'
  | 'advanced';

type SettingsSection = {
  id: SettingsSectionId;
  title: string;
  icon: LucideIcon;
};

const SECTIONS: SettingsSection[] = [
  { id: 'account', title: '계정·권한', icon: UserRound },
  { id: 'market', title: '시장·검색', icon: BarChart3 },
  { id: 'risk', title: '위험관리', icon: ShieldCheck },
  { id: 'scanner', title: '검색기', icon: Search },
  { id: 'telegram', title: '텔레그램', icon: MessageCircle },
  { id: 'ai', title: 'AI', icon: BrainCircuit },
  { id: 'display', title: '화면', icon: Gauge },
  { id: 'provider', title: '데이터 연결', icon: Database },
  { id: 'advanced', title: '고급설정', icon: Settings2 },
];

function parseSection(search: string): SettingsSectionId | null {
  const value = new URLSearchParams(search.replace(/^\?/, '')).get('section');
  return SECTIONS.some((section) => section.id === value) ? value as SettingsSectionId : null;
}

function SettingsCard({ section, onOpen }: { section: SettingsSection; onOpen: () => void }) {
  const Icon = section.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative flex min-h-28 w-full min-w-0 flex-col items-center justify-center gap-2 rounded-2xl border border-card-border bg-card/80 p-3 text-center shadow-sm transition hover:border-primary/30 hover:bg-muted/50 active:scale-[0.99] sm:min-h-32 sm:p-4"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="break-keep text-sm font-semibold text-foreground">{section.title}</span>
      <ChevronRight className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" aria-hidden="true" />
    </button>
  );
}

function LinkButton({ label, href, navigate }: { label: string; href: string; navigate: (href: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => navigate(href)}
      className="flex min-h-11 w-full items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground"
    >
      {label}
    </button>
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'min-h-11 rounded-xl border px-3 text-xs font-semibold transition',
            value === option.value
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-card-border bg-background/70 text-foreground hover:bg-muted',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SectionHeader({ section }: { section: SettingsSection }) {
  const Icon = section.icon;
  return (
    <div className="rounded-2xl border border-card-border bg-card/80 p-4">
      <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
        <span aria-hidden className="h-11 w-11" />
        <div className="min-w-0 text-center">
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" aria-hidden="true" /></span>
          <h2 className="mt-2 break-keep text-base font-bold sm:text-lg">{section.title}</h2>
        </div>
        <span aria-hidden className="h-11 w-11" />
      </div>
    </div>
  );
}

function DetailPanel({ section, navigate }: { section: SettingsSection; navigate: (href: string) => void }) {
  const { settings, update, reset } = useSettings();

  return (
    <div className="space-y-3 sm:space-y-4">
      <SectionHeader section={section} />

      {section.id === 'account' ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4 text-center">
          <p className="text-xs font-medium text-muted-foreground">로그인, 권한과 실계좌 조회 연결을 관리합니다.</p>
          <LinkButton label="계정 열기" href="/account" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'market' ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4 text-center">
          <p className="text-xs font-medium text-muted-foreground">국내·미국·코인을 하나의 검색에서 찾습니다.</p>
          <LinkButton label="종목 검색" href="/stocks" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'risk' ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4 text-center">
          <p className="text-xs font-medium text-muted-foreground">위험과 승인 근거는 신호검색기에서 확인합니다.</p>
          <LinkButton label="위험 근거 보기" href="/scanner" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'scanner' ? (
        <div className="space-y-4 rounded-2xl border border-card-border bg-card/70 p-4">
          <div>
            <div className="mb-2 text-center text-xs font-semibold text-muted-foreground">기본 검색기</div>
            <Choice<ScannerMode>
              value={settings.defaultScanner}
              options={[{ value: 'daytrade', label: '단타' }, { value: 'swing', label: '스윙' }]}
              onChange={(defaultScanner) => update({ defaultScanner })}
            />
          </div>
          <LinkButton label="검색기 열기" href="/scanner" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'telegram' ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4 text-center">
          <p className="text-xs font-medium leading-5 text-muted-foreground">연결 상태는 사용자 계정의 실제 연동 정보를 기준으로 확인합니다.</p>
          <LinkButton label="텔레그램 연결 확인" href="/account" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'ai' ? (
        <div className="space-y-4 rounded-2xl border border-card-border bg-card/70 p-4">
          <div>
            <div className="mb-2 text-center text-xs font-semibold text-muted-foreground">답변 길이</div>
            <Choice<AiVerbosity>
              value={settings.aiVerbosity}
              options={[
                { value: 'short', label: '간단히' },
                { value: 'medium', label: '기본' },
                { value: 'long', label: '자세히' },
              ]}
              onChange={(aiVerbosity) => update({ aiVerbosity })}
            />
          </div>
          <p className="text-center text-xs font-medium text-muted-foreground">AI 화면의 기본 답변 길이를 선택합니다.</p>
          <LinkButton label="AI 분석" href="/ai-chat" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'display' ? (
        <div className="space-y-5 rounded-2xl border border-card-border bg-card/70 p-4">
          <div>
            <div className="mb-2 text-center text-xs font-semibold text-muted-foreground">테마</div>
            <Choice<ThemeMode>
              value={settings.theme}
              options={[{ value: 'dark', label: '어둡게' }, { value: 'light', label: '밝게' }]}
              onChange={(theme) => update({ theme })}
            />
          </div>
          <label className="block">
            <span className="mb-2 block text-center text-xs font-semibold text-muted-foreground">글자 크기 {Math.round(settings.fontScale * 100)}%</span>
            <input
              aria-label="글자 크기"
              type="range"
              min="0.9"
              max="1.25"
              step="0.05"
              value={settings.fontScale}
              onChange={(event) => update({ fontScale: Number(event.target.value) })}
              className="w-full accent-primary"
            />
          </label>
          <LinkButton label="AI 차트" href="/ai-chart" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'provider' ? (
        <div role="status" className="space-y-1 rounded-2xl border border-card-border bg-card/70 p-4 text-center text-xs font-medium leading-5 text-muted-foreground">
          <p className="font-semibold text-foreground">데이터·AI 연결은 서버 설정을 따릅니다.</p>
          <p>인증정보 원문은 이 화면에 표시하지 않습니다.</p>
        </div>
      ) : null}

      {section.id === 'advanced' ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4 text-center">
          <p className="text-xs font-medium leading-5 text-muted-foreground">이 브라우저의 화면 설정만 초기화합니다.</p>
          <button
            type="button"
            onClick={reset}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-card-border bg-background/70 px-4 text-sm font-semibold text-foreground hover:bg-muted"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            화면 설정 초기화
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function MorePage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const selectedId = parseSection(search);
  const selected = selectedId ? SECTIONS.find((section) => section.id === selectedId) ?? null : null;

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <CenteredPageHeader
        title="설정"
        eyebrow={selected?.title}
        leading={selected ? (
          <button
            type="button"
            aria-label="설정 홈으로 돌아가기"
            onClick={() => navigate('/more')}
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-card-border bg-card text-foreground hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : undefined}
      />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-28 pt-4 sm:px-6 lg:px-8">
        <div className={cn('mx-auto w-full', selected ? 'max-w-3xl' : 'max-w-5xl')}>
          {selected ? (
            <DetailPanel section={selected} navigate={navigate} />
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3" data-testid="settings-compact-grid">
              {SECTIONS.map((section) => (
                <SettingsCard
                  key={section.id}
                  section={section}
                  onOpen={() => navigate(`/more?section=${section.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
