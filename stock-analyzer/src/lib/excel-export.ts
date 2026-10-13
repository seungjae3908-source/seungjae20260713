export type ExcelCell = string | number | boolean | null | undefined;

export interface ExcelSheet {
  name: string;
  rows: ExcelCell[][];
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function sheetName(value: string, index: number): string {
  const normalized = value.replace(/[\\/:*?\[\]]/g, ' ').trim().slice(0, 31);
  return normalized || `Sheet ${index + 1}`;
}

function cell(value: ExcelCell, header: boolean): string {
  const style = header ? ' ss:StyleID="Header"' : '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<Cell${style}><Data ss:Type="Number">${value}</Data></Cell>`;
  }
  if (typeof value === 'boolean') {
    return `<Cell${style}><Data ss:Type="Boolean">${value ? 1 : 0}</Data></Cell>`;
  }
  const text = value == null ? '' : String(value);
  return `<Cell${style}><Data ss:Type="String">${xml(text)}</Data></Cell>`;
}

export function buildExcelWorkbookXml(sheets: ExcelSheet[]): string {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('EXCEL_SHEET_REQUIRED');
  const names = new Set<string>();
  const worksheets = sheets.map((sheet, index) => {
    let name = sheetName(sheet.name, index);
    let suffix = 2;
    while (names.has(name)) {
      const tail = ` ${suffix++}`;
      name = `${sheetName(sheet.name, index).slice(0, Math.max(1, 31 - tail.length))}${tail}`;
    }
    names.add(name);
    const rows = sheet.rows.map((row, rowIndex) =>
      `<Row>${row.map((value) => cell(value, rowIndex === 0)).join('')}</Row>`,
    ).join('');
    return `<Worksheet ss:Name="${xml(name)}"><Table>${rows}</Table></Worksheet>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>`
    + `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" `
    + `xmlns:o="urn:schemas-microsoft-com:office:office" `
    + `xmlns:x="urn:schemas-microsoft-com:office:excel" `
    + `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">`
    + `<Styles><Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Bottom"/>`
    + `</Style><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Pattern="Solid"/></Style></Styles>`
    + worksheets
    + `</Workbook>`;
}

export function downloadExcelWorkbook(filename: string, sheets: ExcelSheet[]): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const safeFilename = filename.trim().replace(/[^A-Za-z0-9._가-힣-]+/g, '_') || 'research-report.xls';
  const name = /\.xls$/i.test(safeFilename) ? safeFilename : `${safeFilename}.xls`;
  const blob = new Blob([buildExcelWorkbookXml(sheets)], {
    type: 'application/vnd.ms-excel;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
