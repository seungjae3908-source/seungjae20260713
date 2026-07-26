export type ChartRelayMessageKind = 'signal' | 'price';

export type ChartRelayMessage = {
  id: string;
  kind: ChartRelayMessageKind;
  symbol: string;
  asset: string;
  title: string;
  summary: string;
  price?: number | null;
  occurredAt: string;
  createdAt: number;
  unread: boolean;
};

export const CHART_RELAY_MESSAGE_EVENT = 'chart-relay-message-change';
const STORAGE_KEY = 'chart-relay-message-inbox-v1';
const MAX_MESSAGES = 100;

function safeParse(value: string | null): ChartRelayMessage[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ChartRelayMessage =>
        Boolean(item) &&
        typeof item.id === 'string' &&
        typeof item.symbol === 'string' &&
        typeof item.title === 'string' &&
        typeof item.summary === 'string',
    );
  } catch {
    return [];
  }
}

function writeMessages(messages: ChartRelayMessage[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(0, MAX_MESSAGES)));
    window.dispatchEvent(new CustomEvent(CHART_RELAY_MESSAGE_EVENT));
  } catch {
    // 저장 공간을 사용할 수 없으면 메시지함 저장만 생략합니다.
  }
}

export function readChartRelayMessages(): ChartRelayMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    return safeParse(window.localStorage.getItem(STORAGE_KEY)).sort(
      (left, right) => right.createdAt - left.createdAt,
    );
  } catch {
    return [];
  }
}

export function addChartRelayMessage(
  message: Omit<ChartRelayMessage, 'createdAt' | 'unread'> & {
    createdAt?: number;
    unread?: boolean;
  },
): void {
  const current = readChartRelayMessages();
  const nextMessage: ChartRelayMessage = {
    ...message,
    createdAt: message.createdAt ?? Date.now(),
    unread: message.unread ?? true,
  };
  const withoutDuplicate = current.filter((item) => item.id !== nextMessage.id);
  writeMessages([nextMessage, ...withoutDuplicate]);
}

export function markChartRelayMessagesRead(): void {
  const current = readChartRelayMessages();
  if (!current.some((item) => item.unread)) return;
  writeMessages(current.map((item) => ({ ...item, unread: false })));
}

export function clearChartRelayMessages(): void {
  writeMessages([]);
}
