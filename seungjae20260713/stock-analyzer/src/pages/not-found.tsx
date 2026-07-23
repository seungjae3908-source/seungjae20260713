export default function NotFound() {
  return (
    <div className="flex h-full flex-1 items-center justify-center bg-background p-6 text-center">
      <div>
        <h1 className="mb-4 font-mono text-4xl font-bold text-foreground">404</h1>
        <p className="mb-8 text-lg text-muted-foreground">페이지를 찾을 수 없습니다</p>
        <a
          href="/"
          className="rounded-xl border border-card-border bg-card px-6 py-3 font-medium text-foreground transition-transform hover:bg-card/80 active:scale-95"
        >
          홈으로 돌아가기
        </a>
      </div>
    </div>
  );
}
