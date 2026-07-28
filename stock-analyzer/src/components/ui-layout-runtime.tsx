import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { X } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import {
  UI_COMPONENT_CATALOG,
  normalizeUiLayout,
  type UiLayout,
  type UiPageKey,
  type UiSection,
} from '@/lib/ui-layout';

function pageFromPath(path: string): UiPageKey | null {
  if (path.startsWith('/admin/ui-builder')) return null;
  if (path.startsWith('/tech/signal-scan')) return 'signal-scan';
  if (path === '/' || path.startsWith('/home')) return 'home';
  if (path.startsWith('/stock-info') || path.startsWith('/stock/')) return 'stock-info';
  if (path.startsWith('/stocks') || path.startsWith('/coins/')) return 'stocks';
  if (path.startsWith('/tech')) return 'tech';
  if (path.startsWith('/portfolio') || path.startsWith('/assets')) return 'portfolio';
  if (path.startsWith('/settings') || path.startsWith('/more')) return 'settings';
  return null;
}

function widthValue(section: UiSection) {
  if (section.width === 'half') return '50%';
  if (section.width === 'third') return '33.333%';
  if (section.width === 'auto') return 'auto';
  return '100%';
}

function minHeightValue(section: UiSection) {
  if (section.height === 'compact') return '48px';
  if (section.height === 'normal') return '80px';
  if (section.height === 'tall') return '140px';
  return '';
}

function marginValue(section: UiSection) {
  if (section.spacing === 'none') return '0px';
  if (section.spacing === 'xs') return '4px';
  if (section.spacing === 'sm') return '8px';
  if (section.spacing === 'lg') return '20px';
  if (section.spacing === 'xl') return '28px';
  return '12px';
}

function fontSizeValue(section: UiSection) {
  if (section.fontSize === 'xs') return '12px';
  if (section.fontSize === 'sm') return '14px';
  if (section.fontSize === 'lg') return '18px';
  if (section.fontSize === 'xl') return '20px';
  if (section.fontSize === '2xl') return '24px';
  return '16px';
}

function fontWeightValue(section: UiSection) {
  if (section.fontWeight === 'normal') return '400';
  if (section.fontWeight === 'medium') return '500';
  if (section.fontWeight === 'bold') return '700';
  return '900';
}

function radiusValue(section: UiSection) {
  if (section.radius === 'none') return '0px';
  if (section.radius === 'sm') return '6px';
  if (section.radius === 'md') return '12px';
  if (section.radius === 'lg') return '16px';
  if (section.radius === 'full') return '9999px';
  return '24px';
}

function applyStyle(element: HTMLElement, section: UiSection) {
  element.dataset.uiLayoutNode = section.id;
  element.style.display = section.visible ? '' : 'none';
  const preserveStructure =
    section.component.startsWith('navigation.') || Boolean(section.parentId && !section.custom);
  if (!preserveStructure) {
    element.style.width = widthValue(section);
    element.style.minHeight = minHeightValue(section);
    element.style.marginTop = marginValue(section);
    element.style.backgroundColor = section.backgroundColor || '';
    element.style.borderColor = section.borderColor || '';
    element.style.borderRadius = radiusValue(section);
  }
  element.style.textAlign = section.align;
  element.style.opacity = String(section.opacity / 100);
  element.style.transform = `translate(${section.x}px, ${section.y}px)`;
  element.style.zIndex = String(section.zIndex);
  element.style.position = section.x || section.y || section.zIndex ? 'relative' : '';
  element.style.color = section.textColor || '';
  element.style.setProperty('--ui-title-font-size', fontSizeValue(section));
  element.style.setProperty('--ui-title-font-weight', fontWeightValue(section));
  element.dataset.uiPopupTitle = section.popupTitle ?? '';
  element.dataset.uiPopupContent = section.popupContent ?? '';
  element.dataset.uiPopupPosition = section.popupPosition ?? 'center';
  element.dataset.uiSourceType = section.sourceType;
  element.dataset.uiSourcePath = section.sourcePath ?? '';
}

function makeCustomNode(section: UiSection, pageKey: UiPageKey) {
  const clickable =
    section.kind === 'button' ||
    section.kind === 'tab' ||
    section.kind === 'item' ||
    section.kind === 'popup';
  const element = document.createElement(clickable ? 'button' : section.kind === 'text' ? 'p' : 'div');
  element.setAttribute('data-custom-ui-node', section.id);
  element.setAttribute('data-custom-ui-page', pageKey);
  if (clickable) element.setAttribute('type', 'button');
  element.textContent = section.title || '새 항목';
  element.style.boxSizing = 'border-box';
  element.style.padding = section.kind === 'text' ? '6px 4px' : '12px 14px';
  element.style.borderStyle = section.kind === 'text' ? 'none' : 'solid';
  element.style.borderWidth = section.kind === 'text' ? '0' : '1px';
  element.style.borderColor = section.borderColor || 'hsl(var(--card-border))';
  element.style.backgroundColor = section.backgroundColor || (section.kind === 'text' ? 'transparent' : 'hsl(var(--card))');
  element.style.color = section.textColor || 'hsl(var(--foreground))';
  element.style.fontSize = fontSizeValue(section);
  element.style.fontWeight = fontWeightValue(section);
  element.style.cursor = clickable ? 'pointer' : 'default';
  element.style.boxShadow = section.kind === 'card' ? '0 8px 24px rgba(0,0,0,.12)' : '';
  applyStyle(element, section);
  return element;
}

function applyLayout(root: HTMLElement, layout: UiLayout) {
  root
    .querySelectorAll(`[data-custom-ui-page="${layout.pageKey}"]`)
    .forEach((node) => node.remove());

  const catalog = UI_COMPONENT_CATALOG[layout.pageKey];
  const byComponent = new Map(layout.sections.map((section) => [section.component, section]));
  const resolved = new Map<string, HTMLElement>();
  const main = root.querySelector<HTMLElement>('main');

  for (const definition of catalog) {
    if (!definition.selector) continue;
    const element = root.querySelector<HTMLElement>(definition.selector);
    if (!element) continue;
    const section = byComponent.get(definition.component);
    if (!section) {
      element.style.display = 'none';
      continue;
    }
    resolved.set(section.id, element);
    applyStyle(element, section);
    if (!section.visible) continue;

    if (definition.replaceText && section.title) {
      element.textContent = section.title;
    } else if (definition.titleSelector && section.title) {
      const title = element.querySelector<HTMLElement>(definition.titleSelector);
      if (title) {
        title.textContent = section.title;
        title.style.fontSize = fontSizeValue(section);
        title.style.fontWeight = fontWeightValue(section);
        title.style.textAlign = section.align;
        title.style.color = section.textColor || '';
      }
    } else if (section.kind === 'button' && section.title) {
      element.setAttribute('aria-label', section.title);
    }
  }

  const customSections = layout.sections
    .filter((section) => section.custom)
    .sort((a, b) => a.order - b.order);

  for (const section of customSections) {
    const parent = section.parentId ? resolved.get(section.parentId) : main;
    if (!parent) continue;
    const element = makeCustomNode(section, layout.pageKey);
    resolved.set(section.id, element);
    parent.appendChild(element);
  }

  if (!main) return;
  const orderedMainChildren: HTMLElement[] = [];
  for (const section of layout.sections.filter((item) => !item.parentId)) {
    const element = resolved.get(section.id);
    if (!element) continue;
    if (element.parentElement === main || element.hasAttribute('data-custom-ui-node')) {
      orderedMainChildren.push(element);
    }
  }

  const desiredOrder = orderedMainChildren.map(
    (element) => element.dataset.uiLayoutNode || element.dataset.customUiNode || '',
  );
  const currentOrder = Array.from(main.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .map((element) => element.dataset.uiLayoutNode || element.dataset.customUiNode || '')
    .filter(Boolean);

  if (desiredOrder.join('|') !== currentOrder.join('|')) {
    orderedMainChildren.forEach((element) => main.appendChild(element));
  }
}

async function fetchLayout(pageKey: UiPageKey): Promise<UiLayout | null> {
  try {
    const response = await authorizedFetch(`/api/ui-layouts/${pageKey}/published`);
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: { layout?: unknown } | null };
    return body?.version?.layout ? normalizeUiLayout(body.version.layout, pageKey) : null;
  } catch {
    return null;
  }
}

export default function UiLayoutRuntime() {
  const [location, navigate] = useLocation();
  const pageKey = useMemo(() => pageFromPath(location), [location]);
  const [pageLayout, setPageLayout] = useState<UiLayout | null>(null);
  const [navigationLayout, setNavigationLayout] = useState<UiLayout | null>(null);
  const [popup, setPopup] = useState<{
    title: string;
    content: string;
    position: 'center' | 'bottom' | 'top';
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPageLayout(null);
    void fetchLayout('navigation').then((layout) => {
      if (!cancelled) setNavigationLayout(layout);
    });
    if (pageKey) {
      void fetchLayout(pageKey).then((layout) => {
        if (!cancelled) setPageLayout(layout);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [pageKey]);

  useEffect(() => {
    const layouts = [pageLayout, navigationLayout].filter((item): item is UiLayout => Boolean(item));
    if (!layouts.length) return;
    const root = document.querySelector<HTMLElement>('[data-app-shell]');
    if (!root) return;

    let timer = 0;
    let applying = false;
    let observer: MutationObserver;
    const observe = () => observer.observe(root, { childList: true, subtree: true });
    const run = () => {
      if (applying) return;
      applying = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        observer.disconnect();
        layouts.forEach((layout) => applyLayout(root, layout));
        applying = false;
        observe();
      }, 20);
    };

    observer = new MutationObserver(() => run());
    observe();
    run();

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      layouts.forEach((layout) => {
        root
          .querySelectorAll(`[data-custom-ui-page="${layout.pageKey}"]`)
          .forEach((node) => node.remove());
      });
    };
  }, [navigationLayout, pageLayout]);

  useEffect(() => {
    const handleClick = async (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-ui-layout-node]');
      if (!target) return;

      const title = target.dataset.uiPopupTitle ?? '';
      const content = target.dataset.uiPopupContent ?? '';
      const position = (target.dataset.uiPopupPosition ?? 'center') as 'center' | 'bottom' | 'top';
      const sourceType = target.dataset.uiSourceType ?? 'none';
      const sourcePath = target.dataset.uiSourcePath ?? '';

      if (title || content) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPopup({ title: title || target.textContent?.trim() || '안내', content, position });
        return;
      }

      if (sourceType === 'route' && sourcePath.startsWith('/')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        navigate(sourcePath);
        return;
      }

      if (sourceType === 'api' && sourcePath.startsWith('/api/')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPopup({ title: '조회 중', content: '데이터를 불러오고 있습니다.', position: 'center' });
        try {
          const response = await authorizedFetch(sourcePath);
          const body = await response.json().catch(() => ({}));
          setPopup({
            title: response.ok ? '조회 결과' : '조회 실패',
            content: JSON.stringify(body, null, 2).slice(0, 4000),
            position: 'center',
          });
        } catch {
          setPopup({ title: '조회 실패', content: 'API 데이터를 불러오지 못했습니다.', position: 'center' });
        }
      }
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [navigate]);

  if (!popup) return null;

  return (
    <div
      className={`fixed inset-0 z-[100] flex bg-black/65 p-4 ${
        popup.position === 'bottom'
          ? 'items-end'
          : popup.position === 'top'
            ? 'items-start pt-20'
            : 'items-center'
      }`}
      onClick={() => setPopup(null)}
    >
      <section
        className="mx-auto max-h-[75vh] w-full max-w-md overflow-y-auto rounded-3xl border border-card-border bg-background p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-black">{popup.title}</h2>
          <button
            type="button"
            onClick={() => setPopup(null)}
            className="rounded-xl border border-card-border p-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <pre className="mt-4 whitespace-pre-wrap break-words font-sans text-sm font-bold leading-6 text-muted-foreground">
          {popup.content || '내용이 없습니다.'}
        </pre>
      </section>
    </div>
  );
}
