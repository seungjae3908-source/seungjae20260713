import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type LazyPanelProps = {
  children?: ReactNode;
  className?: string;
  [key: string]: unknown;
};

export default function LazyPanel({
  children,
  className,
}: LazyPanelProps) {
  return <div className={cn(className)}>{children}</div>;
}
