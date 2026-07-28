import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { authorizedFetch } from '@/lib/auth-fetch';
import type { UiLayout, UiPageKey, UiSection } from '@/lib/ui-layout';

const pageFromPath = (path: string): UiPageKey | null => {
  if (/^\/(home)?(?:\?|$)/.test(path)) return 'home';
  if (path.startsWith('/stocks') || path.startsWith('/coins')) return 'stocks';
  if (path.startsWith('/stock-info') || path.startsWith('/stock/')) return 'stock-info';
  if (path.startsWith('/tech/signal-scan')) return 'signal-scan';
  if (path.startsWith('/tech')) return 'tech';
  if (path.startsWith('/portfolio')) return 'portfolio';
  if (path.startsWith('/settings') || path.startsWith('/more')) return 'settings';
  return null;
};

const size: Record<string, string> = { xs: '0.75rem', sm: '0.875rem', md: '1rem', lg: '1.125rem', xl: '1.25rem', '2xl': '1.5rem' };
const weight: Record<string, string> = { normal: '400', medium: '500', bold: '700', black: '900' };
const radius: Record<string, string> = { none: '0', sm: '0.375rem', md: '0.5rem', lg: '0.75rem', xl: '1rem', full: '9999px' };
const gap: Record<string, string> = { none: '0', xs: '0.25rem', sm: '0.5rem', md: '0.75rem', lg: '1rem', xl: '1.5rem' };

function applySection(element: HTMLElement, section: UiSection) {
  element.hidden = section.visible === false;
  element.style.order = String(section.order);
  element.style.textAlign = section.align;
  element.style.fontSize = size[section.fontSize] ?? '';
  element.style.fontWeight = weight[section.fontWeight] ?? '';
  element.style.opacity = String((section.opacity ?? 100) / 100);
  element.style.borderRadius = radius[section.radius] ?? '';
  element.style.marginTop = gap[section.spacing] ?? '';
  element.style.transform = `translate(${section.x ?? 0}px, ${section.y ?? 0}px)`;
  element.style.zIndex = String(section.zIndex ?? 0);
  if (section.backgroundColor) element.style.backgroundColor = section.backgroundColor;
  if (section.textColor) element.style.color = section.textColor;
  if (section.borderColor) element.style.borderColor = section.borderColor;
  if (section.width === 'half') element.style.width = '50%';
  else if (section.width === 'third') element.style.width = '33.333%';
  else if (section.width === 'full') element.style.width = '100%';
  else element.style.width = '';
  const title = element.querySelector<HTMLElement>('[data-ui-title]');
  if (title && section.title) title.textContent = section.title;
}

function customNode(section: UiSection) {
  const node = document.createElement(section.route ? 'button' : 'section');
  node.dataset.uiRuntimeCustom = section.id;
  node.dataset.uiComponent = section.component;
  node.className = 'rounded-2xl border border-card-border bg-card px-4 py-3 text-center shadow-sm';
  const title = document.createElement('p');
  title.dataset.uiTitle = 'true';
  title.className = 'font-black';
  title.textContent = section.title || '새 요소';
  node.append(title);
  if (section.popupContent) {
    const content = document.createElement('p');
    content.className = 'mt-1 whitespace-pre-wrap text-sm text-muted-foreground';
    content.textContent = section.popupContent;
    node.append(content);
  }
  if (section.route) node.addEventListener('click', () => { window.location.href = section.route; });
  return node;
}

function applyLayout(pageKey: UiPageKey, layout: UiLayout) {
  const root = document.querySelector<HTMLElement>(`[data-ui-page="${pageKey}"]`);
  if (!root) return;
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.querySelectorAll<HTMLElement>('[data-ui-runtime-custom]').forEach((node) => node.remove());
  for (const section of layout.sections) {
    const targets = root.querySelectorAll<HTMLElement>(`[data-ui-component="${CSS.escape(section.component)}"]`);
    if (targets.length) targets.forEach((element) => applySection(element, section));
    else if (section.custom && section.visible !== false) {
      const node = customNode(section);
      root.append(node);
      applySection(node, section);
    }
  }
  root.dataset.uiLayoutApplied = 'true';
}

export function UiLayoutRuntime() {
  const [location] = useLocation();
  useEffect(() => {
    const pageKey = pageFromPath(location);
    if (!pageKey) return;
    let active = true;
    let observer: MutationObserver | null = null;
    void authorizedFetch(`/api/ui-layouts/${pageKey}/published`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        const layout = payload?.version?.layout as UiLayout | undefined;
        if (!active || !layout?.sections) return;
        const run = () => applyLayout(pageKey, layout);
        run();
        observer = new MutationObserver(() => window.requestAnimationFrame(run));
        observer.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true });
      })
      .catch(() => undefined);
    return () => { active = false; observer?.disconnect(); };
  }, [location]);
  return null;
}
