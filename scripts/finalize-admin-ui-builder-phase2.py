from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


builder = Path("stock-analyzer/src/pages/admin-ui-builder.tsx")
replace_once(
    builder,
    '''                    <button
                      type="button"
                      onClick={() => setSelectedId(section.id)}''',
    '''                    <div
                      onClick={() => setSelectedId(section.id)}''',
)
replace_once(
    builder,
    '''                      </span>
                    </button>
                  </div>
                ))}''',
    '''                      </span>
                    </div>
                  </div>
                ))}''',
)

runtime = Path("stock-analyzer/src/components/ui-layout-runtime.tsx")
replace_once(
    runtime,
    '''  const orderedMainChildren: HTMLElement[] = [];
  for (const section of layout.sections) {
    const element = resolved.get(section.id);
    if (!element) continue;
    if (element.parentElement === main || element.hasAttribute('data-custom-ui-node')) {
      orderedMainChildren.push(element);
    }
  }
  orderedMainChildren.forEach((element) => main.appendChild(element));''',
    '''  const orderedMainChildren: HTMLElement[] = [];
  for (const section of layout.sections) {
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
  }''',
)

print("phase 2 finalization patch applied")
