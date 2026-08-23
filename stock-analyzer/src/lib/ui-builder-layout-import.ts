import type {
  UiBuilderDeviceClass,
  UiBuilderFullLayoutDocument,
  UiBuilderFullValidationIssue,
  UiBuilderPageId,
} from './ui-builder-full-layout';
import { parseAndValidateUiBuilderRuntimeLayout } from './ui-builder-runtime-safety';

export const UI_BUILDER_LAYOUT_FILE_MAX_BYTES = 1_000_000;

export type UiBuilderFileImportResult = {
  valid: boolean;
  layout: UiBuilderFullLayoutDocument | null;
  issues: UiBuilderFullValidationIssue[];
};

export async function importUiBuilderLayoutFile(
  file: Pick<File, 'size' | 'text'>,
  pageId: UiBuilderPageId,
  device: UiBuilderDeviceClass,
): Promise<UiBuilderFileImportResult> {
  if (file.size > UI_BUILDER_LAYOUT_FILE_MAX_BYTES) {
    return {
      valid: false,
      layout: null,
      issues: [{ code: 'LAYOUT_FILE_TOO_LARGE', message: 'Layout JSON 파일은 1MB 이하여야 합니다.' }],
    };
  }
  const raw = await file.text();
  return parseAndValidateUiBuilderRuntimeLayout(raw, pageId, device);
}
