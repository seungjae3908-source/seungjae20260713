import { getSearchSuggestions, saveSearchHistory } from '@/lib/search-autocomplete';

const SEARCH_HINT = /검색|search|종목|주식|티커|ticker|심볼|symbol|코인|코드 입력/i;

function isSearchInput(input: HTMLInputElement): boolean {
  if (input.type === 'search') return true;
  const context = [
    input.placeholder,
    input.getAttribute('aria-label'),
    input.name,
    input.id,
  ]
    .filter(Boolean)
    .join(' ');
  return SEARCH_HINT.test(context);
}

function inputContext(input: HTMLInputElement): string {
  return (
    input.getAttribute('aria-label') ||
    input.placeholder ||
    input.name ||
    input.id ||
    '검색'
  );
}

function dispatchValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  );
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function refreshDatalist(input: HTMLInputElement, datalist: HTMLDataListElement): void {
  const suggestions = getSearchSuggestions(inputContext(input), input.value, 12);
  datalist.replaceChildren(
    ...suggestions.map((suggestion) => {
      const option = document.createElement('option');
      option.value = suggestion.value;
      if (suggestion.label) option.label = suggestion.label;
      return option;
    }),
  );
}

function trailingButtonOffset(input: HTMLInputElement): number {
  const parent = input.parentElement;
  if (!parent) return 8;
  const followingButton = Array.from(parent.children).find(
    (child) =>
      child !== input &&
      child instanceof HTMLButtonElement &&
      child.dataset.globalSearchClear !== 'true',
  );
  if (!(followingButton instanceof HTMLElement)) return 8;
  return Math.max(48, followingButton.offsetWidth + 14);
}

function enhanceSearchInput(input: HTMLInputElement): void {
  if (input.dataset.globalSearchEnhanced === 'true') return;
  if (!isSearchInput(input)) return;
  if (input.closest('[data-smart-search-field="true"]')) return;
  if (input.disabled || input.readOnly) return;

  input.dataset.globalSearchEnhanced = 'true';
  input.autocomplete = 'off';

  const parent = input.parentElement;
  if (!parent) return;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

  const datalist = document.createElement('datalist');
  const datalistId = `search-suggestions-${Math.random().toString(36).slice(2)}`;
  datalist.id = datalistId;
  input.setAttribute('list', datalistId);
  document.body.appendChild(datalist);
  refreshDatalist(input, datalist);

  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.dataset.globalSearchClear = 'true';
  clearButton.setAttribute('aria-label', '검색어 지우기');
  clearButton.textContent = '×';
  Object.assign(clearButton.style, {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    zIndex: '12',
    width: '28px',
    height: '28px',
    borderRadius: '9999px',
    border: '1px solid rgba(148,163,184,.24)',
    background: 'rgba(148,163,184,.14)',
    color: 'inherit',
    fontSize: '18px',
    fontWeight: '800',
    lineHeight: '24px',
    cursor: 'pointer',
    display: input.value ? 'flex' : 'none',
    alignItems: 'center',
    justifyContent: 'center',
  });

  const updateLayout = () => {
    const right = trailingButtonOffset(input);
    clearButton.style.right = `${right}px`;
    const currentPadding = Number.parseFloat(getComputedStyle(input).paddingRight) || 0;
    input.style.paddingRight = `${Math.max(currentPadding, right + 34)}px`;
  };

  const update = () => {
    clearButton.style.display = input.value ? 'flex' : 'none';
    refreshDatalist(input, datalist);
    updateLayout();
  };

  clearButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dispatchValue(input, '');
    input.focus();
    update();
  });

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('blur', () => {
    saveSearchHistory(inputContext(input), input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveSearchHistory(inputContext(input), input.value);
  });

  parent.appendChild(clearButton);
  updateLayout();

  const resizeObserver = new ResizeObserver(updateLayout);
  resizeObserver.observe(parent);
}

function scanSearchInputs(root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>('input').forEach(enhanceSearchInput);
}

function startSearchEnhancer(): void {
  scanSearchInputs();
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node instanceof HTMLInputElement) enhanceSearchInput(node);
        scanSearchInputs(node);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startSearchEnhancer, { once: true });
} else {
  startSearchEnhancer();
}
