import { createRoot, type Root } from 'react-dom/client';
import UiBuilderLayoutControlPage from '@/pages/ui-builder-layout-control';

let mountedRoot: Root | null = null;

export function mountUiBuilderControlForE2E() {
  const existing = document.getElementById('root');
  if (existing) existing.style.display = 'none';
  const previous = document.getElementById('ui-builder-control-e2e-root');
  if (previous) previous.remove();
  mountedRoot?.unmount();
  const host = document.createElement('div');
  host.id = 'ui-builder-control-e2e-root';
  host.style.height = '100dvh';
  document.body.appendChild(host);
  mountedRoot = createRoot(host);
  mountedRoot.render(<UiBuilderLayoutControlPage />);
}
