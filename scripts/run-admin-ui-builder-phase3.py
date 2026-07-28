#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts/apply-admin-ui-builder-phase3.py"

script = SOURCE.read_text(encoding="utf-8")

old_condition = '''replace_once(
    signal,
    '<div className="grid grid-cols-2 gap-2">',
    '<div data-ui-edit="signal-scan.condition-panel" className="grid grid-cols-2 gap-2">',
    "signal condition slot",
)'''
new_condition = '''replace_once(
    signal,
    '<section data-ui-edit="signal-scan.filters" className="mt-3 rounded-2xl border border-card-border bg-card p-3">\\n          <div className="grid grid-cols-2 gap-2">',
    '<section data-ui-edit="signal-scan.filters" className="mt-3 rounded-2xl border border-card-border bg-card p-3">\\n          <div data-ui-edit="signal-scan.condition-panel" className="grid grid-cols-2 gap-2">',
    "signal condition slot",
)'''
if old_condition not in script:
    raise SystemExit("phase3 launcher: condition patch marker not found")
script = script.replace(old_condition, new_condition, 1)

namespace = {"__file__": str(SOURCE), "__name__": "__main__"}
exec(compile(script, str(SOURCE), "exec"), namespace)


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"phase3 launcher [{label}] expected one match, found {count}: {path}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


runtime = ROOT / "stock-analyzer/src/components/ui-layout-runtime.tsx"
replace_once(
    runtime,
    '''function applyStyle(element: HTMLElement, section: UiSection) {
  element.dataset.uiLayoutNode = section.id;
  element.style.display = section.visible ? '' : 'none';
  element.style.width = widthValue(section);
  element.style.minHeight = minHeightValue(section);
  element.style.marginTop = marginValue(section);
  element.style.textAlign = section.align;
  element.style.opacity = String(section.opacity / 100);
  element.style.transform = `translate(${section.x}px, ${section.y}px)`;
  element.style.zIndex = String(section.zIndex);
  element.style.position = section.x || section.y || section.zIndex ? 'relative' : '';
  element.style.backgroundColor = section.backgroundColor || '';
  element.style.color = section.textColor || '';
  element.style.borderColor = section.borderColor || '';
  element.style.borderRadius = radiusValue(section);
  element.style.setProperty('--ui-title-font-size', fontSizeValue(section));
  element.style.setProperty('--ui-title-font-weight', fontWeightValue(section));''',
    '''function applyStyle(element: HTMLElement, section: UiSection) {
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
  element.style.setProperty('--ui-title-font-weight', fontWeightValue(section));''',
    "preserve nested structure",
)

replace_once(
    runtime,
    '''    let timer = 0;
    let applying = false;
    const run = () => {
      if (applying) return;
      applying = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        layouts.forEach((layout) => applyLayout(root, layout));
        applying = false;
      }, 20);
    };

    run();
    const observer = new MutationObserver(() => run());
    observer.observe(root, { childList: true, subtree: true });''',
    '''    let timer = 0;
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
    run();''',
    "observer self mutation guard",
)

internal = ROOT / "stock-analyzer/src/components/ui-internal-editor.tsx"
replace_once(
    internal,
    '''                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}''',
    '''                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(item.id)}''',
    "internal list wrapper open",
)
replace_once(
    internal,
    '''                    ) : null}
                  </button>
                ))''',
    '''                    ) : null}
                  </div>
                ))''',
    "internal list wrapper close",
)

print("✅ UI 편집기 3차 보정 및 최종 소스 생성 완료")
