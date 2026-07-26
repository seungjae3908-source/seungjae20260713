import { Router, type IRouter, type Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  closeShadowPosition,
  getShadowStatus,
  getShadowTradeExportRows,
  openShadowPosition,
  resetShadowAccount,
  type ShadowDirection,
  type ShadowMarket,
  type ShadowTradeExportRow,
} from '../services/shadow-trading.service';

const router: IRouter = Router();

function memberId(req: AuthenticatedRequest) {
  const id = String(req.member?.id ?? '').trim();
  if (!id) throw new Error('회원 정보를 확인하지 못했습니다.');
  return id;
}

function sendError(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : 'SHADOW_TRADING_ERROR';
  res.status(400).json({
    ok: false,
    mode: 'SHADOW',
    realOrdersEnabled: false,
    error: 'SHADOW_TRADING_REJECTED',
    message,
  });
}

function xmlEscape(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function textCell(value: unknown, style = 'Text') {
  return `<Cell ss:StyleID="${style}"><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`;
}

function numberCell(value: number, style = 'Number') {
  const safe = Number.isFinite(value) ? value : 0;
  return `<Cell ss:StyleID="${style}"><Data ss:Type="Number">${safe}</Data></Cell>`;
}

function workbookXml(rows: ShadowTradeExportRow[]) {
  const headers = [
    '종목명',
    '구매일자',
    '매도일자',
    '진입가격',
    '청산가격',
    '원금',
    '이익합산금액',
    '이익률',
    '수수료',
    '총 마진',
  ];
  const headerRow = `<Row>${headers.map((header) => textCell(header, 'Header')).join('')}</Row>`;
  const dataRows = rows
    .map(
      (row) =>
        `<Row>${[
          textCell(row.displayName),
          textCell(row.openedAt, 'Date'),
          textCell(row.closedAt, 'Date'),
          numberCell(row.entryPrice, 'Price'),
          numberCell(row.exitPrice, 'Price'),
          numberCell(row.allocatedCapitalKRW, 'KRW'),
          numberCell(row.cumulativeProfitKRW, 'KRW'),
          numberCell(row.profitRatePercent / 100, 'Percent'),
          numberCell(row.feeKRW, 'KRW'),
          numberCell(row.totalMarginKRW, 'KRW'),
        ].join('')}</Row>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="맑은 고딕" ss:Size="10"/></Style>
  <Style ss:ID="Header"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="맑은 고딕" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#2563EB" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  <Style ss:ID="Text"><Alignment ss:Vertical="Center"/></Style>
  <Style ss:ID="Date"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>
  <Style ss:ID="Number"><NumberFormat ss:Format="0.00"/></Style>
  <Style ss:ID="Price"><NumberFormat ss:Format="0.########"/></Style>
  <Style ss:ID="KRW"><NumberFormat ss:Format="#,##0;[Red]-#,##0"/></Style>
  <Style ss:ID="Percent"><NumberFormat ss:Format="0.00%;[Red]-0.00%"/></Style>
 </Styles>
 <Worksheet ss:Name="매매일지">
  <Table ss:ExpandedColumnCount="10" ss:ExpandedRowCount="${rows.length + 1}" x:FullColumns="1" x:FullRows="1">
   <Column ss:Width="120"/><Column ss:Width="125"/><Column ss:Width="125"/><Column ss:Width="90"/><Column ss:Width="90"/><Column ss:Width="85"/><Column ss:Width="100"/><Column ss:Width="70"/><Column ss:Width="80"/><Column ss:Width="90"/>
   ${headerRow}${dataRows}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions>
 </Worksheet>
</Workbook>`;
}

router.get('/status', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    res.json(await getShadowStatus(memberId(req)));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/export.xls', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const rows = await getShadowTradeExportRows(memberId(req));
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="shadow-trading-journal-${date}.xls"`,
    );
    res.send(`\uFEFF${workbookXml(rows)}`);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/open', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const result = await openShadowPosition(memberId(req), {
      market: String(req.body?.market ?? '') as ShadowMarket,
      symbol: String(req.body?.symbol ?? ''),
      direction: String(req.body?.direction ?? '') as ShadowDirection,
      notionalKRW: Number(req.body?.notionalKRW),
      stopPrice:
        req.body?.stopPrice == null || req.body?.stopPrice === ''
          ? null
          : Number(req.body.stopPrice),
      targetPrice:
        req.body?.targetPrice == null || req.body?.targetPrice === ''
          ? null
          : Number(req.body.targetPrice),
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/close/:positionId', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    res.json(
      await closeShadowPosition(
        memberId(req),
        String(req.params.positionId ?? ''),
        String(req.body?.reason ?? 'USER_SHADOW_CLOSE'),
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/reset', async (req: AuthenticatedRequest, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    if (String(req.body?.confirmText ?? '') !== 'RESET_200000_SHADOW') {
      throw new Error('가상계좌 초기화 확인문구가 일치하지 않습니다.');
    }
    res.json(await resetShadowAccount(memberId(req)));
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
