// Notification type catalogue. Today these drive the in-app 알림 (호재/악재)
// feed; the same enum is the contract for future push notifications, so the
// server can tag every alert with a stable `NotificationType` and clients can
// let users opt in/out per type.
import type { MarketAlert } from '@/lib/api';

export type NotificationKind = 'positive' | 'negative'; // 호재 / 악재

export type NotificationType =
  | 'news_positive' // 호재 뉴스
  | 'news_negative' // 악재 뉴스
  | 'disclosure_positive' // 호재 공시
  | 'disclosure_negative' // 악재 공시
  | 'ai_strong_buy' // AI 강력매수
  | 'ai_sell_signal' // AI 매도 전환
  | 'golden_cross' // 골든크로스
  | 'volume_surge' // 거래량 급증
  | 'capital_event'; // 유상증자 / 오퍼링 / CB / BW

export const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  news_positive: '호재 뉴스',
  news_negative: '악재 뉴스',
  disclosure_positive: '호재 공시',
  disclosure_negative: '악재 공시',
  ai_strong_buy: 'AI 강력매수',
  ai_sell_signal: 'AI 매도 전환',
  golden_cross: '골든크로스',
  volume_surge: '거래량 급증',
  capital_event: '유상증자·오퍼링·CB·BW',
};

export const NOTIFICATION_KIND: Record<NotificationType, NotificationKind> = {
  news_positive: 'positive',
  news_negative: 'negative',
  disclosure_positive: 'positive',
  disclosure_negative: 'negative',
  ai_strong_buy: 'positive',
  ai_sell_signal: 'negative',
  golden_cross: 'positive',
  volume_surge: 'positive',
  capital_event: 'negative',
};

const CAPITAL_KEYWORDS = ['유상증자', '오퍼링', 'ATM', 'CB', 'BW', '전환사채', '신주인수권'];

// ---------------------------------------------------------------------------
// Browser notification + push helpers.
// All helpers return a friendly Korean status object and never throw, so a
// missing feature / blocked permission / absent VAPID key can't crash the UI.
// ---------------------------------------------------------------------------

export interface NotificationResult {
  ok: boolean;
  message: string;
  permission?: NotificationPermission;
}

/** True when the runtime exposes the Notification API. */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** True when browser push (service worker + PushManager) is available. */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

/** Public VAPID key from env, or undefined when not configured. */
export function getVapidPublicKey(): string | undefined {
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  return key && key.trim().length > 0 ? key.trim() : undefined;
}

/** Current permission status as a friendly Korean label. */
export function getPermissionLabel(): string {
  if (!isNotificationSupported()) return '지원 안 됨';
  switch (Notification.permission) {
    case 'granted':
      return '허용됨';
    case 'denied':
      return '차단됨';
    default:
      return '미설정';
  }
}

/**
 * Request browser Notification permission. Safe in every environment — returns
 * a result object instead of throwing. This works even without a VAPID key.
 */
export async function requestNotificationPermission(): Promise<NotificationResult> {
  if (!isNotificationSupported()) {
    return { ok: false, message: '이 브라우저는 알림을 지원하지 않습니다.' };
  }

  if (Notification.permission === 'denied') {
    return {
      ok: false,
      message: '알림이 차단되어 있습니다. 브라우저 설정에서 허용해 주세요.',
      permission: 'denied',
    };
  }

  try {
    const permission = await Notification.requestPermission();

    if (permission === 'granted') {
      return { ok: true, message: '허용됨', permission };
    }

    if (permission === 'denied') {
      return {
        ok: false,
        message: '알림 권한이 거부되었습니다.',
        permission,
      };
    }

    return { ok: false, message: '미설정', permission };
  } catch {
    return { ok: false, message: '알림 권한 요청에 실패했습니다.' };
  }
}

/** Show a local notification if permitted; never throws. */
export function showLocalNotification(title: string, body?: string): void {
  try {
    if (isNotificationSupported() && Notification.permission === 'granted') {
      new Notification(title, body ? { body } : undefined);
    }
  } catch {
    // ignore — a failed local notification must not break the UI
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

export interface PushSubscribeResult extends NotificationResult {
  subscription?: PushSubscription;
}

/**
 * Subscribe to browser push. Handles every failure path gracefully:
 * unsupported runtime, missing service worker, blocked permission, absent
 * VAPID key, or server rejection. Always resolves — never throws.
 */
export async function subscribeToPush(
  saveSubscription: (subscription: PushSubscription) => Promise<unknown>,
): Promise<PushSubscribeResult> {
  if (!isPushSupported()) {
    return {
      ok: false,
      message: '이 브라우저는 푸시 알림을 지원하지 않습니다.',
    };
  }

  const publicKey = getVapidPublicKey();

  if (!publicKey) {
    return {
      ok: false,
      message:
        '서버 푸시 키 설정 필요 — 브라우저 알림 권한은 사용할 수 있습니다.',
    };
  }

  const permission = await requestNotificationPermission();

  if (!permission.ok) {
    return permission;
  }

  try {
    const registration = await navigator.serviceWorker.ready;

    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      }));

    try {
      await saveSubscription(subscription);
    } catch {
      return {
        ok: false,
        message: '푸시 구독 정보를 서버에 저장하지 못했습니다.',
      };
    }

    return {
      ok: true,
      message: '푸시 구독 완료',
      subscription,
    };
  } catch {
    return { ok: false, message: '푸시 구독에 실패했습니다.' };
  }
}

/** Unsubscribe from browser push; never throws. */
export async function unsubscribeFromPush(
  removeSubscription: (endpoint: string) => Promise<unknown>,
): Promise<NotificationResult> {
  if (!isPushSupported()) {
    return { ok: false, message: '이 브라우저는 푸시 알림을 지원하지 않습니다.' };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      return { ok: true, message: '이미 구독 해제된 상태입니다.' };
    }

    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();

    try {
      await removeSubscription(endpoint);
    } catch {
      // Server cleanup failure is non-fatal for the client.
    }

    return { ok: true, message: '푸시 구독을 해제했습니다.' };
  } catch {
    return { ok: false, message: '푸시 구독 해제에 실패했습니다.' };
  }
}

/** Classify a market alert into a stable notification type (push-ready). */
export function classifyAlert(a: MarketAlert): NotificationType {
  if (a.category === '차트 신호') {
    if (a.title.includes('골든크로스')) return 'golden_cross';
    if (a.title.includes('거래량')) return 'volume_surge';
    return a.kind === 'positive' ? 'ai_strong_buy' : 'ai_sell_signal';
  }
  if (a.category === '뉴스') {
    return a.kind === 'positive' ? 'news_positive' : 'news_negative';
  }
  // Disclosures / filings.
  if (CAPITAL_KEYWORDS.some((k) => a.category.includes(k) || a.title.includes(k))) {
    return 'capital_event';
  }
  return a.kind === 'positive' ? 'disclosure_positive' : 'disclosure_negative';
}
