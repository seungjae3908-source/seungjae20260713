import { useLocation } from 'wouter';
import { Radar, LineChart, Bot, ChevronRight } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { useMemberPermissions, type AppFeature } from '@/lib/permissions';

type TechItem = {
  href: string;
  label: string;
  desc: string;
  icon: typeof Radar;
  feature?: AppFeature;
};

const ITEMS: TechItem[] = [
  {
    href: '/tech/signal-scan',
    label: '신호검색',
    desc: '시장별 매수·매도 후보를 기술적 신호로 찾아봅니다.',
    icon: Radar,
  },
  {
    href: '/tech/chart-relay',
    label: '차트중계',
    desc: '실시간 차트 위 신호를 해설과 함께 중계합니다.',
    icon: LineChart,
  },
  {
    href: '/tech/auto-trade',
    label: '자동매매',
    desc: '가격 조건 감지와 사용자 승인 후 실제 주문을 관리합니다.',
    icon: Bot,
    feature: 'autoTrading',
  },
];

export default function TechPage() {
  const [, navigate] = useLocation();
  const permissions = useMemberPermissions();
  const visibleItems = ITEMS.filter(
    (item) => !item.feature || permissions.has(item.feature),
  );

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <div className="mx-auto max-w-md px-4 pb-28 pt-6">
        <header className="text-center">
          <h1 className="text-lg font-extrabold">기술</h1>
          <p className="mt-1 text-[11px] font-bold text-muted-foreground">
            신호검색과 차트중계를 한 곳에서 이용합니다.
          </p>
        </header>

        <div className="mt-5 space-y-3">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.href}
                type="button"
                onClick={() => navigate(item.href)}
                className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-card p-4 text-left"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-secondary text-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black">{item.label}</p>
                  <p className="mt-0.5 text-[11px] font-bold text-muted-foreground">
                    {item.desc}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
