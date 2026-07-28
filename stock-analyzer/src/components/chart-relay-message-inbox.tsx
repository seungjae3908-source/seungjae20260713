import { useEffect, useMemo, useState } from 'react';
import { Inbox, Trash2, X } from 'lucide-react';
import {
  CHART_RELAY_MESSAGE_EVENT,
  clearChartRelayMessages,
  markChartRelayMessagesRead,
  readChartRelayMessages,
  type ChartRelayMessage,
} from '@/lib/chart-relay-message-store';
import { cn } from '@/lib/utils';

function formatMessageTime(value: string, createdAt: number): string {
  const parsed = Date.parse(value);
  const time = Number.isFinite(parsed) ? parsed : createdAt;
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

function MessageCard({ message }: { message: ChartRelayMessage }) {
  return (
    <article className="rounded-2xl border border-card-border bg-card p-3 text-left">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {message.unread && (
              <span className="h-2 w-2 rounded-full bg-primary" aria-label="읽지 않음" />
            )}
            <p className="truncate text-sm font-black">{message.symbol}</p>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[9px] font-black text-muted-foreground">
              {message.kind === 'price' ? '가격 알림' : '신호 알림'}
            </span>
          </div>
          <p className="mt-1 text-xs font-black">{message.title}</p>
          <p className="mt-1 break-keep text-[10px] font-bold leading-4 text-muted-foreground">
            {message.summary}
          </p>
        </div>
        <time className="shrink-0 text-[9px] font-bold text-muted-foreground">
          {formatMessageTime(message.occurredAt, message.createdAt)}
        </time>
      </div>
    </article>
  );
}

export function ChartRelayMessageInboxButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChartRelayMessage[]>(() =>
    readChartRelayMessages(),
  );

  useEffect(() => {
    const refresh = () => setMessages(readChartRelayMessages());
    window.addEventListener(CHART_RELAY_MESSAGE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHART_RELAY_MESSAGE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const unreadCount = useMemo(
    () => messages.filter((message) => message.unread).length,
    [messages],
  );

  const openInbox = () => {
    setOpen(true);
    markChartRelayMessagesRead();
    setMessages(readChartRelayMessages());
  };

  return (
    <>
      <button
        type="button"
        onClick={openInbox}
        aria-label={`메시지함${unreadCount > 0 ? ` 읽지 않은 메시지 ${unreadCount}개` : ''}`}
        className={cn(
          'relative flex h-10 items-center justify-center gap-1 rounded-xl border border-card-border bg-card px-2 text-xs font-black',
          className,
        )}
      >
        <Inbox className="h-4 w-4" />
        <span>메시지함</span>
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex min-h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-black text-primary-foreground">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[125] flex items-center justify-center bg-black/70 p-3"
          onClick={() => setOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="차트중계 메시지함"
            className="relative max-h-[calc(100dvh-24px)] w-full max-w-md overflow-y-auto rounded-3xl border border-card-border bg-background p-4 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="메시지함 닫기"
              className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="pr-12 text-center">
              <Inbox className="mx-auto h-5 w-5 text-primary" />
              <h2 className="mt-2 text-lg font-black">메시지함</h2>
              <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                관심종목에서 발생한 차트 신호와 가격 도달 알림을 모아서 표시합니다.
              </p>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  clearChartRelayMessages();
                  setMessages([]);
                }}
                disabled={messages.length === 0}
                className="flex items-center gap-1 rounded-xl border border-card-border bg-card px-3 py-2 text-[10px] font-black disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" /> 전체 삭제
              </button>
            </div>

            <div className="mt-3 space-y-2">
              {messages.length === 0 ? (
                <div className="rounded-2xl bg-secondary px-4 py-8 text-center text-xs font-bold text-muted-foreground">
                  저장된 메시지가 없습니다.
                </div>
              ) : (
                messages.map((message) => (
                  <MessageCard key={message.id} message={message} />
                ))
              )}
            </div>

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-4 h-11 w-full rounded-2xl bg-primary text-sm font-black text-primary-foreground"
            >
              닫기
            </button>
          </section>
        </div>
      )}
    </>
  );
}
