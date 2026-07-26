import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { PageFallback } from '@/components/data-state';

/**
 * 기존 기술 메뉴 경로를 관리자 전용 실제 자동매매 화면으로 통합한다.
 * 권한 검사는 /auto-trading 라우트의 autoTrading 게이트에서 수행한다.
 */
export default function AutoTradePage() {
  const [, navigate] = useLocation();

  useEffect(() => {
    navigate('/auto-trading', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <PageFallback />;
}
