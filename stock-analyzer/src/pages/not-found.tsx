export default function NotFound() {
  return (
    <div className="flex-1 flex items-center justify-center p-6 text-center bg-background">
      <div>
        <h1 className="text-4xl font-mono font-bold text-foreground mb-4">404</h1>
        <p className="text-muted-foreground mb-8 text-lg">페이지를 찾을 수 없습니다</p>
        <a 
          href="/" 
          className="bg-card border border-card-border text-foreground px-6 py-3 rounded-xl font-medium active:scale-95 transition-transform hover:bg-card/80"
        >
          홈으로 돌아가기
        </a>
      </div>
    </div>
  );
}
