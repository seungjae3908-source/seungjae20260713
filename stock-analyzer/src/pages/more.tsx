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
import { BackupSettings } from '@/components/backup-settings';
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
  status?: string;
};

const SECTIONS: SettingsSection[] = [
  { id: 'account', title: '계정·권한', icon: UserRound },
  { id: 'market', title: '시장·거래', icon: BarChart3 },
  { id: 'risk', title: '위험관리', icon: ShieldCheck },
  { id: 'scanner', title: '검색기', icon: Search },
  { id: 'telegram', title: '텔레그램', icon: MessageCircle, status: '미연결' },
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
      className="flex min-h-16 w-full min-w-0 items-center gap-2 rounded-2xl border border-card-border bg-card/80 p-3 text-left shadow-sm transition hover:bg-muted/60 active:scale-[0.99] sm:gap-3 sm:p-4"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary sm:h-11 sm:w-11">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="break-keep text-xs font-black text-foreground sm:text-sm">{section.title}</span>
          {section.status ? (
            <span className="shrink-0 whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-500 sm:px-2 sm:text-[10px]">
              {section.status}
            </span>
          ) : null}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

function LinkButton({ label, href, navigate }: { label: string; href: string; navigate: (href: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => navigate(href)}
      className="flex min-h-11 w-full items-center justify-center rounded-xl bg-primary px-4 text-sm font-black text-primary-foreground"
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
            'min-h-11 rounded-xl border px-3 text-xs font-black transition',
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
    <div className="rounded-2xl border border-card-border bg-card/80 p-3 sm:p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-keep text-base font-black sm:text-lg">{section.title}</h2>
            {section.status ? (
              <span className="whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-500">
                {section.status}
              </span>
            ) : null}
          </div>
        </div>
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
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4">
          <p className="text-xs font-bold text-muted-foreground">연결과 권한은 계정 화면에서 관리합니다.</p>
          <LinkButton label="계정 열기" href="/account" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'market' ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4">
          <p className="text-xs font-bold text-muted-foreground">국내·미국·코인을 한 검색에서 찾습니다.</p>
          <LinkButton label="종목 검색" href="/stocks" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'risk' ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4">
          <p className="text-xs font-bold text-muted-foreground">위험·승인 한도는 서버 정책을 따릅니다.</p>
          <LinkButton label="위험 근거" href="/scanner" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'scanner' ? (
        <div className="space-y-4 rounded-2xl border border-card-border bg-card/70 p-4">
          <div>
            <div className="mb-2 text-xs font-black text-muted-foreground">기본 검색기</div>
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
        <div role="status" className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs font-bold leading-5 text-amber-100">
          텔레그램 미연결 · 연결 전까지 앱 내부 상태만 표시합니다.
        </div>
      ) : null}

      {section.id === 'ai' ? (
        <div className="space-y-4 rounded-2xl border border-card-border bg-card/70 p-4">
          <div>
            <div className="mb-2 text-xs font-black text-muted-foreground">답변 길이</div>
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
          <p className="text-xs font-bold text-muted-foreground">공개 시장데이터만 사용합니다.</p>
          <LinkButton label="AI 분석" href="/ai-chat" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'display' ? (
        <div className="space-y-5 rounded-2xl border border-card-border bg-card/70 p-4">
          <div>
            <div className="mb-2 text-xs font-black text-muted-foreground">테마</div>
            <Choice<ThemeMode>
              value={settings.theme}
              options={[{ value: 'dark', label: '어둡게' }, { value: 'light', label: '밝게' }]}
              onChange={(theme) => update({ theme })}
            />
          </div>
          <label className="block">
            <span className="mb-2 block text-xs font-black text-muted-foreground">글자 크기 {Math.round(settings.fontScale * 100)}%</span>
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
        <div role="status" className="space-y-1 rounded-2xl border border-card-border bg-card/70 p-4 text-xs font-bold leading-5 text-muted-foreground">
          <p className="text-foreground">데이터·AI 연결은 서버에서 관리합니다.</p>
          <p>인증정보는 화면에 표시하지 않습니다.</p>
        </div>
      ) : null}

      {section.id === 'advanced' ? (
        <>
        <BackupSettings />
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4">
          <p className="text-xs font-bold leading-5 text-muted-foreground">이 브라우저의 화면 설정만 초기화합니다.</p>
          <button
            type="button"
            onClick={reset}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-card-border bg-background/70 px-4 text-sm font-black text-foreground hover:bg-muted"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            화면 설정 초기화
          </button>
        </div>
        </>
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
