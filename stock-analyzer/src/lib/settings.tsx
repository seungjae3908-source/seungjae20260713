import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { storage } from '@/lib/platform';

export type ThemeMode = 'dark' | 'light';
export type AiVerbosity = 'short' | 'medium' | 'long';
export type ScannerMode = 'daytrade' | 'swing';

export const ALERT_TYPES = [
  '골든크로스',
  '데드크로스',
  'RSI 과매도',
  'MACD 골든크로스',
  '거래량 급증',
  'AI 강력매수',
  'AI 매도 전환',
  '유상증자',
  'CB/BW',
  '상장폐지 주의',
  '뉴스 호재',
  '뉴스 악재',
] as const;

// 관심종목 알림 타입: 뉴스 / 공시 / 급등락 / 목표가 접근 / 손절가 접근.
// more.tsx의 알림 종류 토글이 이 목록을 사용합니다.
export type WatchlistAlertType =
  | 'news'
  | 'disclosure'
  | 'move'
  | 'target'
  | 'stop';

export interface WatchlistAlertOption {
  key: WatchlistAlertType;
  title: string;
  desc: string;
}

export const WATCHLIST_ALERT_TYPES: WatchlistAlertOption[] = [
  { key: 'news', title: '뉴스 알림', desc: '관심종목 호재·악재 뉴스' },
  { key: 'disclosure', title: '공시 알림', desc: '증자·계약·배당·상장폐지 주의' },
  { key: 'move', title: '급등락 알림', desc: '관심종목 급등·급락 변동 감지' },
  { key: 'target', title: '목표가 접근 알림', desc: '목표가 접근 또는 돌파' },
  { key: 'stop', title: '손절가 접근 알림', desc: '손절가 접근 또는 이탈' },
];

export interface Settings {
  theme: ThemeMode;
  fontScale: number; // 0.9 - 1.25
  aiVerbosity: AiVerbosity;
  alertTypes: string[];
  defaultScanner: ScannerMode;
}

const DEFAULTS: Settings = {
  theme: 'dark',
  fontScale: 1,
  aiVerbosity: 'medium',
  alertTypes: [...ALERT_TYPES],
  defaultScanner: 'swing',
};

const STORAGE_KEY = 'sa-settings-v1';

function load(): Settings {
  return { ...DEFAULTS, ...storage.getJSON<Partial<Settings>>(STORAGE_KEY, {}) };
}

interface SettingsContextValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(load);

  // Apply theme + typography + translucency to the document.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', settings.theme === 'dark');
    root.style.colorScheme = settings.theme;
    root.style.fontSize = `${Math.round(16 * settings.fontScale)}px`;
    // Cards float translucently over the app's dark gradient backdrop.
    root.style.setProperty('--bg-alpha', '0');
    root.style.setProperty('--card-alpha', '0.72');
  }, [settings.theme, settings.fontScale]);

  useEffect(() => {
    storage.setJSON(STORAGE_KEY, settings);
  }, [settings]);

  const update = (patch: Partial<Settings>) =>
    setSettings((s) => ({ ...s, ...patch }));
  const reset = () => setSettings(DEFAULTS);

  return (
    <SettingsContext.Provider value={{ settings, update, reset }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
