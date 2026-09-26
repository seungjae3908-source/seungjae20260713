import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';

const WATERMARK_COPIES = 30;
const REFRESH_INTERVAL_MS = 60_000;

function formatMinute(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export async function anonymousMemberWatermarkCode(userId: string): Promise<string | null> {
  const normalized = userId.trim();
  if (!normalized || !globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`member-privacy-watermark-v1:${normalized}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 6))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export function MemberPrivacyWatermark() {
  const { user, isApproved } = useAuth();
  const [memberCode, setMemberCode] = useState<string | null>(null);
  const [minute, setMinute] = useState(() => formatMinute(new Date()));

  useEffect(() => {
    let active = true;
    const userId = user?.id ?? '';
    if (!userId || !isApproved) {
      setMemberCode(null);
      return () => { active = false; };
    }

    void anonymousMemberWatermarkCode(userId).then((next) => {
      if (active) setMemberCode(next);
    });
    return () => { active = false; };
  }, [isApproved, user?.id]);

  useEffect(() => {
    if (!memberCode) return;
    const timer = window.setInterval(() => setMinute(formatMinute(new Date())), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [memberCode]);

  const marks = useMemo(() => Array.from({ length: WATERMARK_COPIES }, (_, index) => index), []);
  if (!memberCode) return null;

  return (
    <div
      aria-hidden="true"
      data-testid="member-privacy-watermark"
      data-watermark-version="v1"
      className="pointer-events-none fixed inset-0 z-[90] select-none overflow-hidden"
    >
      <div
        className="absolute -inset-[18%] grid grid-cols-3 gap-x-14 gap-y-16 opacity-[0.075] sm:grid-cols-4 sm:gap-x-20 sm:gap-y-20 lg:grid-cols-5"
        style={{ transform: 'rotate(-22deg)' }}
      >
        {marks.map((index) => (
          <span
            key={index}
            className="whitespace-nowrap text-[10px] font-semibold tracking-[0.12em] text-slate-950 dark:text-white sm:text-xs"
          >
            보호화면 · {memberCode} · {minute}
          </span>
        ))}
      </div>
    </div>
  );
}
