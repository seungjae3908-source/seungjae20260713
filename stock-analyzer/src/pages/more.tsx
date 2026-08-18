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
  description: string;
  icon: LucideIcon;
  status?: string;
};

const SECTIONS: SettingsSection[] = [
  { id: 'account', title: '계정 및 권한', description: '로그인 상태와 허용된 기능 범위를 확인합니다.', icon: UserRound },
  { id: 'market', title: '시장 · 거래', description: '국내·미국·코인 시장 탐색 경로를 관리합니다.', icon: BarChart3 },
  { id: 'risk', title: 'Risk', description: '위험·승인 계약을 확인합니다. 이 화면에서 한도를 임의 변경하지 않습니다.', icon: ShieldCheck },
  { id: 'scanner', title: 'Scanner', description: '기본 스캐너 전략과 신호 검색 화면으로 이동합니다.', icon: Search },
  { id: 'telegram', title: 'Telegram', description: '외부 알림 채널 상태를 확인합니다.', icon: MessageCircle, status: '미구성' },
  { id: 'ai', title: 'AI', description: 'AI 답변 길이와 공개 시장분석 화면을 설정합니다.', icon: BrainCircuit },
  { id: 'display', title: '차트 · 화면', description: '테마와 글자 크기를 조정합니다.', icon: Gauge },
  { id: 'provider', title: 'Provider', description: '데이터·AI 공급자 경계를 확인합니다. Secret은 브라우저에 표시하지 않습니다.', icon: Database },
  { id: 'advanced', title: '고급설정', description: '일반 사용 경로에 필요하지 않은 안전 안내와 초기화를 제공합니다.', icon: Settings2 },
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
      className="flex min-h-24 w-full min-w-0 items-center gap-3 rounded-2xl border border-card-border bg-card/80 p-4 text-left shadow-sm transition hover:bg-muted/60 active:scale-[0.99]"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 break-keep text-sm font-black text-foreground">{section.title}</span>
          {section.status ? (
            <span className="shrink-0 whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-500">
              {section.status}
            </span>
          ) : null}
        </span>
        <span className="mt-1 block break-keep text-xs leading-5 text-muted-foreground">{section.description}</span>
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

function DetailPanel({ section, navigate }: { section: SettingsSection; navigate: (href: string) => void }) {
  const { settings, update, reset } = useSettings();
  const Icon = section.icon;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-card-border bg-card/80 p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-keep text-lg font-black">{section.title}</h2>
              {section.status ? (
                <span className="whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-500">
                  {section.status}
                </span>
              ) : null}
            </div>
            <p className="mt-1 break-keep text-sm leading-6 text-muted-foreground">{section.description}</p>
          </div>
        </div>
      </div>

      {section.id === 'account' ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4">
          <p className="break-keep text-sm leading-6 text-muted-foreground">계정 연결·권한 확인은 기존 계정 화면을 사용합니다. 이 설정 화면은 계좌번호나 인증정보를 복제하거나 표시하지 않습니다.</p>
          <LinkButton label="계정 및 권한 열기" href="/account" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'market' ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4">
          <p className="break-keep text-sm leading-6 text-muted-foreground">통합검색에서 국내·미국·Upbit 현물·Bitget 선물을 같은 canonical 자산 경로로 탐색합니다.</p>
          <LinkButton label="통합 자산 검색 열기" href="/stocks" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'risk' ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card/70 p-4">
          <p className="break-keep text-sm leading-6 text-muted-foreground">Risk·Approval·Order 계약은 기존 정책 엔진이 source of truth입니다. 설정 화면에서 손절·주문금액·레버리지 한도를 임의로 완화하지 않습니다.</p>
          <LinkButton label="신호와 Risk 근거 확인" href="/scanner" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'scanner' ? (
        <div className="space-y-4 rounded-2xl border border-card-border bg-card/70 p-4">
          <div>
            <div className="mb-2 text-xs font-black text-muted-foreground">기본 Scanner 모드</div>
            <Choice<ScannerMode>
              value={settings.defaultScanner}
              options={[{ value: 'daytrade', label: '단타' }, { value: 'swing', label: '스윙' }]}
              onChange={(defaultScanner) => update({ defaultScanner })}
            />
          </div>
          <LinkButton label="Signal Scanner 열기" href="/scanner" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'telegram' ? (
        <div role="status" className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100">
          <p className="font-black">Telegram 알림 연동은 현재 저장소에 구성된 연결 계약이 없습니다.</p>
          <p className="mt-2 break-keep text-amber-100/80">브라우저 Push·Notification·Sound를 대체 기능처럼 노출하지 않습니다. 안전 상태는 앱 내부 inline 표시로 계속 제공합니다.</p>
        </div>
      ) : null}

      {section.id === 'ai' ? (
        <div className="space-y-4 rounded-2xl border border-card-border bg-card/70 p-4">
          <div>
            <div className="mb-2 text-xs font-black text-muted-foreground">AI 답변 길이</div>
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
          <p className="break-keep text-xs leading-5 text-muted-foreground">AI 시장분석은 공개 시장 context만 사용하며 private 계좌·주문 데이터를 전달하지 않습니다.</p>
          <LinkButton label="AI 시장분석 열기" href="/ai-chat" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'display' ? (
        <div className="space-y-5 rounded-2xl border border-card-border bg-card/70 p-4">
          <div>
            <div className="mb-2 text-xs font-black text-muted-foreground">테마</div>
            <Choice<ThemeMode>
              value={settings.theme}
              options={[{ value: 'dark', label: '다크' }, { value: 'light', label: '라이트' }]}
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
          <LinkButton label="AI Chart 열기" href="/ai-chart" navigate={navigate} />
        </div>
      ) : null}

      {section.id === 'provider' ? (
        <div role="status" className="space-y-2 rounded-2xl border border-card-border bg-card/70 p-4 text-sm leading-6 text-muted-foreground">
          <p className="font-black text-foreground">Provider 설정은 서버 경계에서 관리됩니다.</p>
          <p className="break-keep">API Key·Secret·credential 전체값은 브라우저 설정, localStorage, response, console에 표시하거나 저장하지 않습니다.</p>
          <p className="break-keep">일부 공급자 장애는 가능한 결과를 유지하면서 PARTIAL/DEGRADED/STALE로 표시하고, 실제 데이터가 없으면 성공으로 위장하지 않습니다.</p>
        </div>
      ) : null}

      {section.id === 'advanced' ? (
        <div className="space-y-4 rounded-2xl border border-card-border bg-card/70 p-4">
          <p className="break-keep text-sm leading-6 text-muted-foreground">Debug·admin·서버 운영 설정은 일반 사용자 화면에 노출하지 않습니다. 아래 초기화는 이 브라우저의 화면/AI/Scanner 로컬 기본값만 복원하며 계정·주문·서버 데이터에는 접근하지 않습니다.</p>
          <button
            type="button"
            onClick={reset}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-card-border bg-background/70 px-4 text-sm font-black text-foreground hover:bg-muted"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            로컬 화면 설정 초기화
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
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
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
        infoTitle="설정 안내"
        infoItems={[
          '필요한 항목만 선택해 관리하며 Secret 전체값과 private 계좌정보를 화면에 표시하지 않습니다.',
          '고급 진단과 초기화는 서버·주문·계정 데이터를 변경하지 않습니다.',
        ]}
      />
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-28 pt-4 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-4xl">
          {selected ? (
            <DetailPanel section={selected} navigate={navigate} />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
