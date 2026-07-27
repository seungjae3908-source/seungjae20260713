import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useLocation } from "wouter";
import {
  Bell,
  Download,
  Moon,
  ShieldCheck,
  Smartphone,
  Sun,
  TrendingDown,
  TrendingUp,
  Upload,
  UserRound,
  WalletCards,
} from "lucide-react";
import { BottomNav } from "@/components/bottom-nav";
import { AppModal } from '@/components/app-modal';
import { AiRepairCenter } from "@/components/ai-repair-center";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  restoreRemoteBackup,
  saveBackupNow,
  useBackupStatus,
} from "@/lib/backup-sync";
import { useSettings } from "@/lib/settings";
import { WATCHLIST_ALERT_TYPES } from "@/lib/settings";
import {
  getPermissionLabel,
  getVapidPublicKey,
  isPushSupported,
  requestNotificationPermission,
  showLocalNotification,
  subscribeToPush,
} from "@/lib/notifications";
import { ACCENT_COLOR_KEY } from "@/lib/stock-display";
import { cn } from "@/lib/utils";

const ALERT_ICONS: Record<string, ReactNode> = {
  news: <Bell className="h-4 w-4" />,
  disclosure: <ShieldCheck className="h-4 w-4" />,
  move: <TrendingUp className="h-4 w-4" />,
  target: <TrendingUp className="h-4 w-4" />,
  stop: <TrendingDown className="h-4 w-4" />,
};

const ACCENT_COLORS = [
  {
    key: "blue",
    label: "블루",
    hsl: "221 83% 53%",
    className: "bg-blue-500",
  },
  {
    key: "green",
    label: "그린",
    hsl: "142 71% 45%",
    className: "bg-green-500",
  },
  {
    key: "purple",
    label: "퍼플",
    hsl: "262 83% 58%",
    className: "bg-purple-500",
  },
  {
    key: "red",
    label: "레드",
    hsl: "0 84% 60%",
    className: "bg-red-500",
  },
  {
    key: "orange",
    label: "오렌지",
    hsl: "24 95% 53%",
    className: "bg-orange-500",
  },
  {
    key: "pink",
    label: "핑크",
    hsl: "330 81% 60%",
    className: "bg-pink-500",
  },
];

const BACKUP_PREFIXES = [
  "watchlist",
  "alerts",
  "settings",
  "seungjae",
  "stock-analyzer",
  "sa-settings",
];

function readBackupData() {
  const data: Record<string, string> = {};

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);

    if (!key) continue;

    const keep = BACKUP_PREFIXES.some((prefix) =>
      key.toLowerCase().includes(prefix.toLowerCase()),
    );

    if (keep) {
      data[key] = window.localStorage.getItem(key) ?? "";
    }
  }

  return data;
}

export function applyAccentColor(key: string) {
  const found =
    ACCENT_COLORS.find((color) => color.key === key) ?? ACCENT_COLORS[0];

  document.documentElement.style.setProperty("--primary", found.hsl);
  document.documentElement.style.setProperty("--ring", found.hsl);
}

export default function MorePage() {
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { settings, update } = useSettings();
  const auth = useAuth();
  const remoteBackupStatus = useBackupStatus();
  const memberId = auth.isApproved ? (auth.user?.id ?? null) : null;

  const [enabledAlerts, setEnabledAlerts] = useState<string[]>(() =>
    WATCHLIST_ALERT_TYPES.map((type) => type.key),
  );

  const [accentColor, setAccentColor] = useState(() => {
    if (typeof window === "undefined") return "blue";

    return window.localStorage.getItem(ACCENT_COLOR_KEY) || "blue";
  });

  const [noticeStatus, setNoticeStatus] = useState<string>(() =>
    getPermissionLabel(),
  );

  const [backupStatus, setBackupStatus] = useState("파일 백업 대기 중");
  const [remoteBackupBusy, setRemoteBackupBusy] = useState(false);
  const [settingsPopup, setSettingsPopup] = useState<string | null>(null);

  const isDark = settings.theme === "dark";
  const pushSupported = isPushSupported();
  const hasVapidKey = Boolean(getVapidPublicKey());

  useEffect(() => {
    applyAccentColor(accentColor);
  }, [accentColor]);

  const toggleAlert = (key: string) => {
    setEnabledAlerts((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  };

  const toggleTheme = () => {
    update({ theme: isDark ? "light" : "dark" });
  };

  const changeAccentColor = (key: string) => {
    setAccentColor(key);
    window.localStorage.setItem(ACCENT_COLOR_KEY, key);
    applyAccentColor(key);
  };

  const requestPermission = async () => {
    const result = await requestNotificationPermission();
    setNoticeStatus(result.message);

    if (result.ok) {
      showLocalNotification(
        "승재주식 알림 설정 완료",
        "관심종목 알림을 받을 준비가 되었습니다.",
      );
    }
  };

  const enablePush = async () => {
    if (!hasVapidKey) {
      setNoticeStatus(
        "서버 푸시 키 설정 필요 — 브라우저 알림 권한만 사용할 수 있습니다.",
      );
      return;
    }

    const result = await subscribeToPush((subscription) =>
      api.pushSubscribe(subscription),
    );

    setNoticeStatus(result.message);

    if (result.ok) {
      showLocalNotification(
        "푸시 알림 연결 완료",
        "관심종목 뉴스·공시·등락률 알림을 받을 수 있습니다.",
      );

      try {
        await api.pushTest();
      } catch {
        // 테스트 발송 실패는 UI에 영향을 주지 않습니다.
      }
    }
  };

  const saveServerBackup = async () => {
    if (!memberId) {
      setBackupStatus(
        "승인된 계정으로 로그인해야 서버 백업을 사용할 수 있습니다.",
      );
      return;
    }

    setRemoteBackupBusy(true);

    try {
      await saveBackupNow(memberId);
      setBackupStatus("현재 기기 설정을 서버 최신 백업으로 저장했습니다.");
    } catch (cause) {
      setBackupStatus(
        cause instanceof Error
          ? `서버 백업 저장 실패: ${cause.message}`
          : "서버 백업 저장에 실패했습니다.",
      );
    } finally {
      setRemoteBackupBusy(false);
    }
  };

  const restoreServerBackup = async () => {
    if (!memberId) {
      setBackupStatus(
        "승인된 계정으로 로그인해야 서버 백업을 사용할 수 있습니다.",
      );
      return;
    }

    const confirmed = window.confirm(
      "서버에 저장된 최신 설정으로 현재 기기 설정을 바꿉니다. 계속할까요?",
    );

    if (!confirmed) return;

    setRemoteBackupBusy(true);

    try {
      const count = await restoreRemoteBackup(memberId);
      setBackupStatus(
        `서버 백업 ${count}개 항목을 복원했습니다. 화면을 새로고침합니다.`,
      );

      window.setTimeout(() => {
        window.location.reload();
      }, 300);
    } catch (cause) {
      setBackupStatus(
        cause instanceof Error
          ? `서버 백업 복원 실패: ${cause.message}`
          : "서버 백업 복원에 실패했습니다.",
      );
      setRemoteBackupBusy(false);
    }
  };

  const exportBackup = () => {
    const backup = {
      app: "seungjae-stock",
      version: 1,
      exportedAt: new Date().toISOString(),
      localStorage: readBackupData(),
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: "application/json",
    });

    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = `seungjae-stock-backup-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    anchor.click();

    window.URL.revokeObjectURL(url);
    setBackupStatus("백업 파일을 저장했습니다.");
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        localStorage?: Record<string, string>;
      };

      if (!parsed.localStorage || typeof parsed.localStorage !== "object") {
        setBackupStatus("백업 파일 형식이 맞지 않습니다.");
        return;
      }

      Object.entries(parsed.localStorage).forEach(([key, value]) => {
        window.localStorage.setItem(key, value);
      });

      setBackupStatus("백업을 복원했습니다. 새로고침하면 반영됩니다.");
    } catch {
      setBackupStatus("백업 복원에 실패했습니다.");
    } finally {
      event.target.value = "";
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain bg-background">
      <header className="border-b border-card-border bg-background px-5 py-5">
          <h1 className="text-center text-2xl font-black tracking-tight">설정</h1>
      </header>

        <main className="space-y-5 px-5 py-5 pb-28">
          <>
          <button
            type="button"
            onClick={() => setSettingsPopup('settings-popup-0')}
            className="flex h-[76px] w-full items-center justify-center rounded-2xl border border-card-border bg-card/90 px-4 py-3 text-center shadow-sm"
          >
            <span className="block min-w-0 flex-1 break-keep text-center text-sm font-black">계정 · 자산</span>
          </button>
          <AppModal
            open={settingsPopup === 'settings-popup-0'}
            onClose={() => setSettingsPopup(null)}
            title="계정 · 자산"
          >
            <div className="space-y-3 overflow-x-hidden text-center">



          <button
            type="button"
            onClick={() => navigate("/account")}
            className="flex w-full items-center gap-3 border-b border-card-border py-3 text-center"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-secondary text-primary font-bold font-bold font-bold font-bold">
              <UserRound className="h-4 w-4" />
            </span>
            <div className="text-center min-w-0 flex-1">
              <p className="text-base font-black w-full px-2 text-center">로그인 · 회원가입</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                관심종목, 알림, 포트폴리오를 계정에 저장합니다.
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={() => navigate("/portfolio")}
            className="flex w-full items-center gap-3 py-3 text-center"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-secondary text-primary font-bold font-bold font-bold font-bold">
              <WalletCards className="h-4 w-4" />
            </span>
            <div className="text-center min-w-0 flex-1">
              <p className="text-base font-black w-full px-2 text-center">내 포트폴리오</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                매수가, 수량, 평가손익과 수익률을 확인합니다.
              </p>
            </div>
          </button>
        
            </div>
          </AppModal>
        </>

        <>
          <button
            type="button"
            onClick={() => setSettingsPopup('settings-popup-1')}
            className="flex h-[76px] w-full items-center justify-center rounded-2xl border border-card-border bg-card/90 px-4 py-3 text-center shadow-sm"
          >
            <span className="block min-w-0 flex-1 break-keep text-center text-sm font-black">화면 설정</span>
          </button>
          <AppModal
            open={settingsPopup === 'settings-popup-1'}
            onClose={() => setSettingsPopup(null)}
            title="화면 설정"
          >
            <div className="space-y-3 overflow-x-hidden text-center">




          <button
            type="button"
            onClick={toggleTheme}
            className="flex w-full items-center gap-3 border-b border-card-border py-3 text-center last:border-b-0"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-secondary text-primary font-bold font-bold font-bold font-bold">
              {isDark ? (
                <Moon className="h-4 w-4" />
              ) : (
                <Sun className="h-4 w-4" />
              )}
            </span>

            <div className="text-center min-w-0 flex-1">
              <p className="break-keep text-base font-black leading-relaxed">
                다크모드
              </p>

              <p className="mt-0.5 break-keep text-sm leading-relaxed text-muted-foreground">
                {isDark ? "어두운 화면 사용 중" : "밝은 화면 사용 중"}
              </p>
            </div>

            <span
              className={cn(
                "h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
                isDark ? "bg-primary" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "block h-4 w-4 rounded-full bg-background transition-transform",
                  isDark && "translate-x-4",
                )}
              />
            </span>
          </button>

        
            </div>
          </AppModal>
        </>

        <>
          <button
            type="button"
            onClick={() => setSettingsPopup('settings-popup-2')}
            className="flex h-[76px] w-full items-center justify-center rounded-2xl border border-card-border bg-card/90 px-4 py-3 text-center shadow-sm"
          >
            <span className="block min-w-0 flex-1 break-keep text-center text-sm font-black">휴대폰 알림</span>
          </button>
          <AppModal
            open={settingsPopup === 'settings-popup-2'}
            onClose={() => setSettingsPopup(null)}
            title="휴대폰 알림"
          >
            <div className="space-y-3 overflow-x-hidden text-center">


          <div className="mb-3">


            <p className="mt-1 break-keep text-sm leading-relaxed text-muted-foreground">
              관심종목 뉴스, 공시, 등락률, 목표가/손절가 접근 알림을 받을 수
              있게 연결합니다.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2">
            <button
              type="button"
              onClick={() => void requestPermission()}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-3 text-base font-black text-primary font-bold font-bold font-bold font-bold"
            >
              <Smartphone className="h-4 w-4" />
              브라우저 알림 권한 켜기
            </button>

            <button
              type="button"
              onClick={() => void enablePush()}
              disabled={!pushSupported}
              className={cn(
                "flex w-full items-center justify-center gap-2 rounded-2xl border p-3 text-base font-black",
                pushSupported
                  ? "border-positive/40 bg-positive/10 text-positive"
                  : "border-card-border bg-background text-muted-foreground opacity-60",
              )}
            >
              <Bell className="h-4 w-4" />
              푸시 알림 구독하기
            </button>
          </div>

          {!hasVapidKey && (
            <p className="mt-2 break-keep text-sm font-bold leading-relaxed text-warning">
              서버 푸시 키 설정 필요 — 브라우저 알림 권한은 지금도 사용할 수
              있습니다.
            </p>
          )}

          <p className="mt-2 break-keep text-sm font-bold leading-relaxed text-muted-foreground">
            현재 상태: {noticeStatus}
          </p>
        
            </div>
          </AppModal>
        </>

        <>
          <button
            type="button"
            onClick={() => setSettingsPopup('settings-popup-3')}
            className="flex h-[76px] w-full items-center justify-center rounded-2xl border border-card-border bg-card/90 px-4 py-3 text-center shadow-sm"
          >
            <span className="block min-w-0 flex-1 break-keep text-center text-sm font-black">관심종목 알림 종류</span>
          </button>
          <AppModal
            open={settingsPopup === 'settings-popup-3'}
            onClose={() => setSettingsPopup(null)}
            title="관심종목 알림 종류"
          >
            <div className="space-y-3 overflow-x-hidden text-center">


          <div className="mb-3">


            <p className="mt-1 break-keep text-sm leading-relaxed text-muted-foreground">
              필요한 알림만 켜서 관리합니다.
            </p>
          </div>

          <div className="space-y-2">
            {WATCHLIST_ALERT_TYPES.map((item) => {
              const active = enabledAlerts.includes(item.key);

              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => toggleAlert(item.key)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-2xl border p-3 text-center transition-colors",
                    active
                      ? "border-primary/40 bg-primary/10"
                      : "border-card-border bg-background",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                      active
                        ? "bg-primary text-primary font-bold font-bold font-bold font-bold-foreground"
                        : "bg-secondary text-muted-foreground",
                    )}
                  >
                    {ALERT_ICONS[item.key]}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block break-keep text-base font-black leading-relaxed">
                      {item.title}
                    </span>

                    <span className="mt-0.5 block break-keep text-sm leading-relaxed text-muted-foreground">
                      {item.desc}
                    </span>
                  </span>

                  <span
                    className={cn(
                      "h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
                      active ? "bg-primary" : "bg-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "block h-4 w-4 rounded-full bg-background transition-transform",
                        active && "translate-x-4",
                      )}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        
            </div>
          </AppModal>
        </>

        {auth.isAdmin ? <AiRepairCenter /> : null}

        <>
          <button
            type="button"
            onClick={() => setSettingsPopup('settings-popup-4')}
            className="flex h-[76px] w-full items-center justify-center rounded-2xl border border-card-border bg-card/90 px-4 py-3 text-center shadow-sm"
          >
            <span className="block min-w-0 flex-1 break-keep text-center text-sm font-black">서버 자동백업 / 복원</span>
          </button>
          <AppModal
            open={settingsPopup === 'settings-popup-4'}
            onClose={() => setSettingsPopup(null)}
            title="서버 자동백업 / 복원"
          >
            <div className="space-y-3 overflow-x-hidden text-center">


                                        <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => void saveServerBackup()}
              disabled={!memberId || remoteBackupBusy}
              className="flex items-center justify-center gap-1.5 rounded-2xl border border-primary/40 bg-primary/10 px-3 py-3 text-base font-black text-primary font-bold font-bold font-bold font-bold disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              서버에 저장
            </button>

            <button
              type="button"
              onClick={() => void restoreServerBackup()}
              disabled={!memberId || remoteBackupBusy}
              className="flex items-center justify-center gap-1.5 rounded-2xl border border-positive/40 bg-positive/10 px-3 py-3 text-base font-black text-positive disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Upload className="h-4 w-4" />
              서버 백업 복원
            </button>
          </div>
        
            </div>
          </AppModal>
        </>



        <p className="pb-4 pt-2 text-center text-sm font-bold text-muted-foreground">
          By. Seung Jae Lee
        </p>
      </main>

      <BottomNav />
    </div>
  );
}
