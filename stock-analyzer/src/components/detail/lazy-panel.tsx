import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

type LazyPanelProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  children: ReactNode;
  fallback?: ReactNode;
  placeholder?: ReactNode;
  minHeight?: number | string;
  placeholderHeight?: number | string;
  rootMargin?: string;
  threshold?: number | number[];
  eager?: boolean;
  disabled?: boolean;
};

function cssSize(value: number | string | undefined): string | undefined {
  if (typeof value === 'number') return `${value}px`;
  return value;
}

export default function LazyPanel({
  children,
  fallback,
  placeholder,
  minHeight,
  placeholderHeight,
  rootMargin = '240px 0px',
  threshold = 0.01,
  eager = false,
  disabled = false,
  className,
  style,
  ...divProps
}: LazyPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [shouldRender, setShouldRender] = useState(eager || disabled);

  useEffect(() => {
    if (shouldRender || eager || disabled) return;

    const element = containerRef.current;
    if (!element) return;

    if (typeof IntersectionObserver === 'undefined') {
      setShouldRender(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldRender(true);
        observer.disconnect();
      },
      { rootMargin, threshold },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [disabled, eager, rootMargin, shouldRender, threshold]);

  const reservedHeight = cssSize(placeholderHeight ?? minHeight);
  const placeholderContent = fallback ?? placeholder ?? null;

  return (
    <div
      {...divProps}
      ref={containerRef}
      className={cn(className)}
      style={{
        ...style,
        minHeight: shouldRender
          ? style?.minHeight
          : reservedHeight ?? style?.minHeight,
      }}
    >
      {shouldRender ? children : placeholderContent}
    </div>
  );
}
