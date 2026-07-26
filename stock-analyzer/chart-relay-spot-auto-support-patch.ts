import type { Plugin } from 'vite';

function replaceOnce(source: string, search: string, replacement: string, label: string) {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) {
    throw new Error(`[chart-relay-spot-auto-support-patch] ${label} 위치를 찾지 못했습니다.`);
  }
  return source.replace(search, replacement);
}

function patchSource(source: string) {
  let code = source;

  code = replaceOnce(
    code,
    `type TradeSettings = {
  enabled: boolean;
  stockAmount: string;
  futuresMargin: string;
  leverage: number;
};`,
    `type TradeSettings = {
  enabled: boolean;
  stockAmount: string;
  spotAmount: string;
  spotSellPercent: number;
  futuresMargin: string;
  leverage: number;
};`,
    'settings type',
  );

  code = code.replaceAll(
    `return { enabled: false, stockAmount: '', futuresMargin: '', leverage: 2 };`,
    `return { enabled: false, stockAmount: '', spotAmount: '', spotSellPercent: 25, futuresMargin: '', leverage: 2 };`,
  );

  code = replaceOnce(
    code,
    `      stockAmount: String(parsed.stockAmount ?? ''),
      futuresMargin: String(parsed.futuresMargin ?? ''),`,
    `      stockAmount: String(parsed.stockAmount ?? ''),
      spotAmount: String(parsed.spotAmount ?? ''),
      spotSellPercent: Math.max(1, Math.min(100, Math.round(Number(parsed.spotSellPercent ?? 25) || 25))),
      futuresMargin: String(parsed.futuresMargin ?? ''),`,
    'settings restore',
  );

  code = replaceOnce(
    code,
    `  if (asset === 'stockKR') return \`${'${Math.round(price).toLocaleString()}'}원\`;
  return \`${'${price.toLocaleString(undefined, { maximumFractionDigits: price >= 100 ? 2 : 6 })}'} USDT\`;`,
    `  if (asset === 'stockKR' || asset === 'coinSpot') return \`${'${Math.round(price).toLocaleString()}'}원\`;
  return \`${'${price.toLocaleString(undefined, { maximumFractionDigits: price >= 100 ? 2 : 6 })}'} USDT\`;`,
    'coin spot price format',
  );

  code = replaceOnce(
    code,
    `      if (asset === 'coinSpot') {
        throw new Error('코인 현물 실제 주문은 아직 연결되지 않았습니다. 국내·해외주식 또는 코인 선물을 선택하세요.');
      }

      let response: AnyObj;`,
    `      let response: AnyObj;`,
    'remove spot block',
  );

  code = replaceOnce(
    code,
    `      if (asset === 'stockKR' || asset === 'stockUS') {`,
    `      if (asset === 'coinSpot') {
        const baseSymbol = symbol.toUpperCase().replace(/^KRW-/, '');
        if (trigger.action === 'BUY') {
          const amount = finite(settings.spotAmount);
          if (amount == null) throw new Error('코인 현물 1회 매수금액을 입력하세요.');
          response = await jsonRequest('/api/crypto/spot/auto/plan', key, {
            symbol: baseSymbol,
            side: 'BUY',
            amountKRW: amount,
          });
        } else {
          const accountsResponse = await authorizedFetch('/api/crypto/spot/accounts', {
            cache: 'no-store',
          });
          const accountsPayload = await accountsResponse.json().catch(() => ({}));
          if (!accountsResponse.ok) {
            throw new Error(String(accountsPayload?.message ?? accountsPayload?.error ?? '업비트 보유수량 확인 실패'));
          }
          const account = (Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts : []).find(
            (row: AnyObj) => String(row?.currency ?? '').toUpperCase() === baseSymbol,
          );
          const available = finite(account?.balance);
          if (available == null) throw new Error('매도 가능한 코인 보유수량이 없습니다.');
          const percent = trigger.action === 'CLOSE' ? 100 : settings.spotSellPercent;
          const volume = available * (percent / 100);
          response = await jsonRequest('/api/crypto/spot/auto/plan', key, {
            symbol: baseSymbol,
            side: 'SELL',
            volume,
          });
        }
        executePath = '/api/crypto/spot/auto/execute';
      } else if (asset === 'stockKR' || asset === 'stockUS') {`,
    'spot plan branch',
  );

  code = replaceOnce(
    code,
    `          {asset === 'coinFutures' && (`,
    `          {asset === 'coinSpot' && (
            <>
              <label className="text-[10px] font-black text-muted-foreground">
                1회 매수금액 KRW
                <input
                  type="number"
                  inputMode="decimal"
                  value={settings.spotAmount}
                  onChange={(event) => updateSettings({ spotAmount: event.target.value })}
                  className="mt-1 h-10 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-black outline-none focus:border-primary"
                />
              </label>
              <label className="text-[10px] font-black text-muted-foreground">
                분할매도 비율 %
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={settings.spotSellPercent}
                  onChange={(event) => updateSettings({ spotSellPercent: Math.max(1, Math.min(100, Number(event.target.value) || 1)) })}
                  className="mt-1 h-10 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-black outline-none focus:border-primary"
                />
              </label>
            </>
          )}
          {asset === 'coinFutures' && (`,
    'spot settings ui',
  );

  code = replaceOnce(
    code,
    `
        {asset === 'coinSpot' && (
          <p className="mt-3 rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2 text-center text-[10px] font-black text-warning">
            코인 현물 실제 주문은 아직 연결되지 않았습니다.
          </p>
        )}`,
    ``,
    'remove spot warning',
  );

  return code;
}

export function chartRelaySpotAutoSupportPatch(): Plugin {
  return {
    name: 'chart-relay-spot-auto-support-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/components/chart-relay-auto-order-approval.tsx')) return null;
      return { code: patchSource(source), map: null };
    },
  };
}
