import { useEffect, useState } from 'react';
import { X, ExternalLink, Globe, RefreshCw } from 'lucide-react';

// Lightweight in-app browser: an iframe overlay constrained to the app shell.
// Many news sites block framing (X-Frame-Options / frame-ancestors), so we
// always offer an external-browser fallback button.
export function InAppBrowser({
  url,
  title,
  onClose,
}: {
  url: string;
  title: string;
  onClose: () => void;
}) {
  const [blocked, setBlocked] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Lock background scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // If the frame hasn't loaded shortly, assume it was blocked and surface the fallback.
  useEffect(() => {
    const id = setTimeout(() => {
      if (!loaded) setBlocked(true);
    }, 2500);
    return () => clearTimeout(id);
  }, [loaded]);

  const openExternal = () => window.open(url, '_blank', 'noopener,noreferrer');

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60">
      <div className="flex h-full w-full max-w-md flex-col bg-background">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <button onClick={onClose} aria-label="닫기" className="rounded-lg p-1 hover:bg-secondary">
            <X className="h-5 w-5" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
            <Globe className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate text-xs">{title}</span>
          </div>
          <button onClick={openExternal} aria-label="외부 브라우저에서 열기" className="rounded-lg p-1 hover:bg-secondary">
            <ExternalLink className="h-5 w-5" />
          </button>
        </header>

        <div className="relative flex-1">
          <iframe
            src={url}
            title={title}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
          />
          {blocked && !loaded && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background px-8 text-center">
              <Globe className="h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                이 기사는 앱 내 브라우저에서 열 수 없습니다. 외부 브라우저에서 원문을 확인하세요.
              </p>
              <button
                onClick={openExternal}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                <ExternalLink className="h-4 w-4" /> 외부 브라우저에서 열기
              </button>
              <button
                onClick={() => {
                  setBlocked(false);
                  setLoaded(false);
                }}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" /> 다시 시도
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
