import { useEffect, useRef, useState, type ReactNode } from "react";

interface LazyPanelProps {
  children: () => ReactNode;
  minHeight?: number;
  rootMargin?: string;
}

export default function LazyPanel({
  children,
  minHeight = 240,
  rootMargin = "360px 0px",
}: LazyPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const host = hostRef.current;
    if (!host || !("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [rootMargin, visible]);

  return (
    <div ref={hostRef} style={visible ? undefined : { minHeight }}>
      {visible ? children() : null}
    </div>
  );
}