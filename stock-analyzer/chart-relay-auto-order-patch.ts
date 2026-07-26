import type { Plugin } from 'vite';

/**
 * 관리자 실제 주문 감시 UI는 전용 자동매매 화면에서만 표시한다.
 * 차트중계 화면에는 더 이상 실제 주문 감시 패널을 삽입하지 않는다.
 */
export function chartRelayAutoOrderPatch(): Plugin {
  return {
    name: 'chart-relay-auto-order-patch',
    enforce: 'pre',
    transform() {
      return null;
    },
  };
}
