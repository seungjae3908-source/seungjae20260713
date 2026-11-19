type Props = { page: number; totalPages: number; onChange: (p: number) => void };

export function TradePagination({ page, totalPages, onChange }: Props) {
  if (totalPages <= 1) return null;
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);
  const pages: number[] = [];
  for (let i = start; i <= end; i++) pages.push(i);
  return (
    <div className="flex items-center justify-center gap-1 pt-3" data-testid="trade-pagination">
      <button onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1}
        className="rounded border px-3 py-1 text-sm disabled:opacity-40">‹</button>
      {start > 1 && <span className="px-2 text-sm text-muted-foreground">…</span>}
      {pages.map(p => (
        <button key={p} onClick={() => onChange(p)}
          className={`rounded border px-3 py-1 text-sm ${p === page ? 'bg-primary text-primary-foreground' : ''}`}>{p}</button>
      ))}
      {end < totalPages && <span className="px-2 text-sm text-muted-foreground">…</span>}
      <button onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page === totalPages}
        className="rounded border px-3 py-1 text-sm disabled:opacity-40">›</button>
    </div>
  );
}
