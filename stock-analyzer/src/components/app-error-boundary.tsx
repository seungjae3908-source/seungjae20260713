import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { useLocation } from 'wouter';
import { describeError, isChunkLoadError } from '@/lib/error-reason';
import { reloadOnceForChunkError } from '@/lib/chunk-load-recovery';

type Props = {
  children: ReactNode;
  /** What this boundary protects, e.g. "종목 상세" — shown in the fallback title. */
  area?: string;
  /** Changing this value (e.g. the route) clears a previous error. */
  resetKey?: unknown;
  /** Compact fallback for panels inside a page. */
  variant?: 'page' | 'panel';
};

type State = { error: unknown; autoReloading: boolean };

/**
 * Catches render / lazy-chunk errors so one failing panel never blanks the
 * whole app. Stale-chunk failures reload the document once automatically;
 * everything else shows a Korean fallback with what failed and 다시 시도.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, autoReloading: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (isChunkLoadError(error) && reloadOnceForChunkError()) {
      this.setState({ autoReloading: true });
      return;
    }
    // Keep a console trace for diagnostics; no user data is included.
    console.error(`[AppErrorBoundary:${this.props.area ?? 'app'}]`, error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null, autoReloading: false });
    }
  }

  private retry = () => {
    if (isChunkLoadError(this.state.error)) {
      window.location.reload();
      return;
    }
    this.setState({ error: null, autoReloading: false });
  };

  render() {
    const { error, autoReloading } = this.state;
    if (!error) return this.props.children;

    const described = describeError(isChunkLoadError(error) ? error : { code: 'RENDER_FAILED' });
    const area = this.props.area;
    const title = area ? `${area} 화면을 표시하지 못했습니다` : described.title;
    const panel = this.props.variant === 'panel';

    return (
      <div
        role="alert"
        data-testid="app-error-boundary"
        data-error-code={described.code ?? undefined}
        className={panel
          ? 'mx-auto w-full max-w-3xl rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-center'
          : 'flex min-h-[50vh] w-full flex-col items-center justify-center gap-3 p-6 text-center'}
      >
        <AlertCircle className="mx-auto h-7 w-7 text-warning" aria-hidden="true" />
        <p className="mt-2 break-keep text-sm font-black">{autoReloading ? '새 버전을 불러오는 중입니다' : title}</p>
        {!autoReloading ? (
          <>
            <p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">{described.reason}</p>
            <p className="break-keep text-xs leading-5 text-muted-foreground">{described.action}</p>
            <button
              type="button"
              onClick={this.retry}
              className="mx-auto mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-4 text-xs font-black"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              다시 시도
            </button>
          </>
        ) : null}
      </div>
    );
  }
}

/** Route-level boundary: resets automatically when the user navigates. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <AppErrorBoundary resetKey={location}>{children}</AppErrorBoundary>;
}
