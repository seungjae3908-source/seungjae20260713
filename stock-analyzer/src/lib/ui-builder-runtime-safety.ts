import {
  makeFrozenUiBuilderTemplate,
  parseAndValidateUiBuilderLayout,
  validateUiBuilderFullLayout,
  type UiBuilderDeviceClass,
  type UiBuilderFullLayoutDocument,
  type UiBuilderFullValidationIssue,
  type UiBuilderPageId,
} from './ui-builder-full-layout';

const HTML_TAG = /<\/?[a-z][^>]*>/i;
const SCRIPT_OR_EVENT = /(?:<\s*script\b|\bon(?:click|load|error|submit|focus|blur|change|input|keydown|keyup|mouseover)\s*=|javascript\s*:)/i;
const JS_SOURCE = /(?:\b(?:eval|Function)\s*\(|\bdocument\.(?:cookie|write)\b|\bwindow\.location\s*=|=>\s*\{|\bfetch\s*\()/i;
const CSS_SOURCE = /(?:<\s*style\b|\bstyle\s*=|@import\s+url\s*\(|expression\s*\()/i;

function textIssues(layout: UiBuilderFullLayoutDocument): UiBuilderFullValidationIssue[] {
  const issues: UiBuilderFullValidationIssue[] = [];
  for (const block of layout.blocks) {
    for (const [label, value] of [['title', block.props.title], ['subtitle', block.props.subtitle]] as const) {
      if (typeof value !== 'string') continue;
      if (SCRIPT_OR_EVENT.test(value) || JS_SOURCE.test(value)) {
        issues.push({ code: 'ARBITRARY_JS_REJECTED', message: `${label}에 JavaScript/실행 코드를 넣을 수 없습니다.`, blockId: block.id });
      }
      if (HTML_TAG.test(value)) {
        issues.push({ code: 'ARBITRARY_HTML_REJECTED', message: `${label}에 HTML source를 넣을 수 없습니다.`, blockId: block.id });
      }
      if (CSS_SOURCE.test(value)) {
        issues.push({ code: 'CSS_SOURCE_REJECTED', message: `${label}에 CSS source를 넣을 수 없습니다.`, blockId: block.id });
      }
    }
  }
  return issues;
}

export function validateUiBuilderRuntimeLayout(
  candidate: unknown,
  pageId: UiBuilderPageId,
  device: UiBuilderDeviceClass,
): { valid: boolean; issues: UiBuilderFullValidationIssue[] } {
  const base = validateUiBuilderFullLayout(candidate, pageId, device);
  if (!base.valid) return base;
  const executable = textIssues(candidate as UiBuilderFullLayoutDocument);
  return { valid: executable.length === 0, issues: executable };
}

export function parseAndValidateUiBuilderRuntimeLayout(
  raw: string,
  pageId: UiBuilderPageId,
  device: UiBuilderDeviceClass,
): { valid: boolean; layout: UiBuilderFullLayoutDocument | null; issues: UiBuilderFullValidationIssue[] } {
  const base = parseAndValidateUiBuilderLayout(raw, pageId, device);
  if (!base.valid || !base.layout) return base;
  const strict = validateUiBuilderRuntimeLayout(base.layout, pageId, device);
  return strict.valid ? base : { valid: false, layout: null, issues: strict.issues };
}

export function safeRuntimeLayoutOrFallback(
  layout: UiBuilderFullLayoutDocument,
  pageId: UiBuilderPageId,
  device: UiBuilderDeviceClass,
): { source: 'active' | 'fallback'; layout: UiBuilderFullLayoutDocument; issues: UiBuilderFullValidationIssue[] } {
  const strict = validateUiBuilderRuntimeLayout(layout, pageId, device);
  if (strict.valid) return { source: 'active', layout, issues: [] };
  return { source: 'fallback', layout: makeFrozenUiBuilderTemplate(pageId, device), issues: strict.issues };
}
