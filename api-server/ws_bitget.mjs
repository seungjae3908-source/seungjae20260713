import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '/root/seungjae20260713/.env' });
dotenv.config({ path: '/root/seungjae20260713/api-server/.env' });

const API_KEY = process.env.BITGET_API_KEY || process.env.API_KEY || "";
const API_SECRET = process.env.BITGET_SECRET_KEY || process.env.SECRET_KEY || "";
const API_PASSPHRASE = process.env.BITGET_PASSPHRASE || process.env.PASSPHRASE || "";

// ★ 앱 제어 연동 (Supabase)
const USER_ID = 'b4331ad7-fde3-444f-bdb3-a4de3cdbdbe4';
const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

async function isAutomaticEnabled() {
    if (!sb) return true;  // Supabase 없으면 안전하게 진행
    try {
        const { data, error } = await sb.from('trade_automation_profiles')
            .select('payload')
            .eq('user_id', USER_ID)
            .maybeSingle();
        if (error) { console.error('[DB] 조회 실패:', error.message); return false; }
        const enabled = data?.payload?.automaticEnabled === true;
        return enabled;
    } catch (e) {
        console.error('[DB] 예외:', e.message);
        return false;
    }
}

// ★ 수동 청산 감지 (포지션이 사라졌는데 candidates에 남아있으면 스킵)
const manualClosedSymbols = new Map(); // symbol -> closedAt(timestamp)
const MANUAL_COOLDOWN_MS = 30 * 60 * 1000; // 30분 쿨다운

async function detectManualClose(openPositions) {
    const activeSymbols = new Set(openPositions.map(p => p.symbol));
    // 이전에 있던 심볼이 지금 없으면 수동 청산으로 간주
    for (const [sym, closedAt] of manualClosedSymbols.entries()) {
        if (Date.now() - closedAt > MANUAL_COOLDOWN_MS) {
            manualClosedSymbols.delete(sym);
        }
    }
    return activeSymbols;
}

const BASE_URL = "https://api.bitget.com";
const CANDIDATE_PATH = "/root/seungjae20260713/api-server/candidates.json";
// 수동 청산 후 스캐너 갱신 전 재진입 방지 메모리 캐시
const processedSignals = new Map();


let isExecutionLocked = false;

// ★ 수동청산 감지 + 30분 쿨다운 (실제 작동)
let _lastOpenSymbols = new Set();
const _manualCooldowns = new Map();
const _MANUAL_COOLDOWN_MS = 30 * 60 * 1000;

// 시작 시 현재 포지션 스냅샷
async function _initSnapshot() {
    try {
        const positions = await getOpenPositions();
        _lastOpenSymbols = new Set(positions.map(p => p.symbol));
        console.log("[초기화] 현재 열린 포지션: " + _lastOpenSymbols.size + "개 (" + [..._lastOpenSymbols].join(',') + ")");
    } catch (e) {}
}

async function _detectManualClose() {
    const positions = await getOpenPositions();
    const currentSymbols = new Set(positions.map(p => p.symbol));
    // 이전엔 있었는데 지금 없는 심볼 = 수동청산 또는 SL
    for (const sym of _lastOpenSymbols) {
        if (!currentSymbols.has(sym)) {
            _manualCooldowns.set(sym, Date.now());
            console.log("🛡️ [수동청산 감지] " + sym + " - 30분간 재진입 금지");
        }
    }
    // 만료된 쿨다운 제거
    for (const [sym, ts] of _manualCooldowns) {
        if (Date.now() - ts > _MANUAL_COOLDOWN_MS) {
            _manualCooldowns.delete(sym);
            console.log("✅ [쿨다운 해제] " + sym);
        }
    }
    _lastOpenSymbols = currentSymbols;
    return currentSymbols;
}

function _isInCooldown(symbol) {
    const ts = _manualCooldowns.get(symbol);
    if (!ts) return false;
    if (Date.now() - ts > _MANUAL_COOLDOWN_MS) {
        _manualCooldowns.delete(symbol);
        return false;
    }
    return true;
}

function sign(timestamp, method, requestPath, body) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const message = timestamp + method.toUpperCase() + requestPath + bodyStr;
    return crypto.createHmac('sha256', API_SECRET).update(message).digest('base64');
}

async function getUsdtBalance() {
    try {
        if (!API_KEY) return 10;
        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = '/api/v2/mix/account/accounts?productType=usdt-futures';
        const signature = sign(timestamp, method, requestPath, '');

        const res = await fetch(BASE_URL + requestPath, {
            method: 'GET',
            headers: {
                'ACCESS-KEY': API_KEY,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': API_PASSPHRASE,
                'Content-Type': 'application/json',
                'Locale': 'en_US'
            }
        });
        const json = await res.json();
        if (json.code === '00000' && json.data) {
            const usdtAccount = json.data.find(acc => acc.marginCoin === 'USDT');
            return usdtAccount ? parseFloat(usdtAccount.usdtEquity || usdtAccount.available || 0) : 10;
        }
    } catch (e) {}
    return 10;
}

async function getOpenPositions() {
    try {
        if (!API_KEY) return [];
        const timestamp = Date.now().toString();
        const method = 'GET';
        const requestPath = '/api/v2/mix/position/all-position?productType=usdt-futures&marginCoin=USDT';
        const signature = sign(timestamp, method, requestPath, '');

        const res = await fetch(BASE_URL + requestPath, {
            method: 'GET',
            headers: {
                'ACCESS-KEY': API_KEY,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': API_PASSPHRASE,
                'Content-Type': 'application/json',
                'Locale': 'en_US'
            }
        });
        const json = await res.json();
        if (json.code === '00000' && json.data) {
            return json.data.filter(p => parseFloat(p.total || p.hold || 0) > 0);
        }
    } catch (e) {}
    return [];
}

async function getMarketPrice(symbol) {
    try {
        const res = await fetch(BASE_URL + '/api/v2/mix/market/ticker?productType=usdt-futures&symbol=' + symbol);
        const json = await res.json();
        if (json.code === '00000' && json.data && json.data.length > 0) {
            return parseFloat(json.data[0].lastPr || json.data[0].close || 0);
        }
    } catch (e) {}
    return 0;
}

async function sendTelegramAlert(message) {
    console.log("📢 [텔레그램 전송]:\n" + message);
}

async function setLeverageAndMarginMode(symbol) {
    try {
        if (!API_KEY) return;
        const timestamp = Date.now().toString();
        const method = 'POST';
        const requestPath = '/api/v2/mix/account/set-leverage';
        
        const bodyLong = { symbol: symbol, productType: 'usdt-futures', leverage: '3', holdSide: 'long' };
        let signature = sign(timestamp, method, requestPath, bodyLong);
        await fetch(BASE_URL + requestPath, { method: 'POST', headers: { 'ACCESS-KEY': API_KEY, 'ACCESS-SIGN': signature, 'ACCESS-TIMESTAMP': timestamp, 'ACCESS-PASSPHRASE': API_PASSPHRASE, 'Content-Type': 'application/json', 'Locale': 'en_US' }, body: JSON.stringify(bodyLong) });

        const bodyShort = { symbol: symbol, productType: 'usdt-futures', leverage: '3', holdSide: 'short' };
        signature = sign(timestamp, method, requestPath, bodyShort);
        await fetch(BASE_URL + requestPath, { method: 'POST', headers: { 'ACCESS-KEY': API_KEY, 'ACCESS-SIGN': signature, 'ACCESS-TIMESTAMP': timestamp, 'ACCESS-PASSPHRASE': API_PASSPHRASE, 'Content-Type': 'application/json', 'Locale': 'en_US' }, body: JSON.stringify(bodyShort) });
    } catch (e) {}
}

async function sendOrderWithRiskControl(symbol, side, targetMarginUSDT) {
    try {
        await setLeverageAndMarginMode(symbol);

        const price = await getMarketPrice(symbol);
        if (price === 0) return;

        const totalNotionalUSDT = targetMarginUSDT * 3;
        let calculatedSize = (totalNotionalUSDT / price).toFixed(4);

        if (symbol.includes('BTC') && parseFloat(calculatedSize) < 0.001) calculatedSize = '0.001';
        if (symbol.includes('ETH') && parseFloat(calculatedSize) < 0.01) calculatedSize = '0.01';

        const isShort = side === 'SHORT';
        let rawStopLoss = isShort ? (price * 1.015) : (price * 0.985);
        const stopLossPrice = (Math.round(rawStopLoss * 10) / 10).toFixed(1);

        console.log("📡 [실계좌 주문 전송] " + symbol + " | 방향: " + side + " | 3배 격리 | 증거금: $" + targetMarginUSDT.toFixed(2) + " | 수량: " + calculatedSize + " | 손절가(SL): $" + stopLossPrice);

        const timestamp = Date.now().toString();
        const method = 'POST';
        const requestPath = '/api/v2/mix/order/place-order';

        const body = {
            symbol: symbol,
            productType: 'usdt-futures',
            marginMode: 'isolated',
            marginCoin: 'USDT',
            size: calculatedSize.toString(),
            side: isShort ? 'sell' : 'buy',
            tradeSide: 'open',
            orderType: 'market',
            force: 'gtc',
            presetStopLossPrice: stopLossPrice.toString(),
            stopLossTriggerType: 'mark_price'
        };

        const signature = sign(timestamp, method, requestPath, body);
        const response = await fetch(BASE_URL + requestPath, {
            method: 'POST',
            headers: { 'ACCESS-KEY': API_KEY, 'ACCESS-SIGN': signature, 'ACCESS-TIMESTAMP': timestamp, 'ACCESS-PASSPHRASE': API_PASSPHRASE, 'Content-Type': 'application/json', 'Locale': 'en_US' },
            body: JSON.stringify(body)
        });

        const result = await response.json();
        console.log("🎯 [실계좌 비트겟 응답 (" + symbol + ")]:", JSON.stringify(result));

        if (result.code === '00000') {
            await sendTelegramAlert(
                "🚨 [실계좌 자동매매 진입 체결]\n" +
                "• 종목: " + symbol + "\n" +
                "• 방향: " + side + " (3배 격리)\n" +
                "• 진입가(참조): $" + price + "\n" +
                "• 수량: " + calculatedSize + "\n" +
                "• 손절가(SL): $" + stopLossPrice + " (-1.5%)"
            );
        }
    } catch (err) {
        console.error("❌ [주문 에러]:", err.message);
    }
}

async function manageActivePositions() {
    try {
        const positions = await getOpenPositions();
        if (positions.length === 0) return;

        for (const pos of positions) {
            const symbol = pos.symbol;
            const holdSide = pos.holdSide;
            const totalSize = parseFloat(pos.total || pos.hold || 0);
            const avgPrice = parseFloat(pos.averageOpenPrice || 0);
            const currentPrice = await getMarketPrice(symbol);

            if (avgPrice === 0) continue;

            const pnlPercent = holdSide === 'short'
                ? ((avgPrice - currentPrice) / avgPrice) * 100 * 3
                : ((currentPrice - avgPrice) / avgPrice) * 100 * 3;

            console.log("📊 [포지션 감시] " + symbol + " (" + holdSide.toUpperCase() + ") | 진입가: $" + avgPrice + " | 현재가: $" + currentPrice + " | 3배 수익률: " + pnlPercent.toFixed(2) + "%");

            if (pnlPercent >= 6 && totalSize > 0.002) {
                const halfSize = (totalSize / 2).toFixed(4);
                console.log("🎯 [1차 익절 도달 (ROE +6%)] " + symbol + " 수량의 50%(" + halfSize + ") 시장가 익절 실행!");

                const timestamp = Date.now().toString();
                const method = 'POST';
                const requestPath = '/api/v2/mix/order/place-order';
                const body = {
                    symbol: symbol,
                    productType: 'usdt-futures',
                    marginMode: 'isolated',
                    marginCoin: 'USDT',
                    size: halfSize.toString(),
                    side: holdSide === 'short' ? 'buy' : 'sell',
                    tradeSide: 'close',
                    orderType: 'market',
                    force: 'gtc'
                };

                const signature = sign(timestamp, method, requestPath, body);
                const res = await fetch(BASE_URL + requestPath, {
                    method: 'POST',
                    headers: { 'ACCESS-KEY': API_KEY, 'ACCESS-SIGN': signature, 'ACCESS-TIMESTAMP': timestamp, 'ACCESS-PASSPHRASE': API_PASSPHRASE, 'Content-Type': 'application/json', 'Locale': 'en_US' },
                    body: JSON.stringify(body)
                });
                const json = await res.json();
                if (json.code === '00000') {
                    await sendTelegramAlert("💰 [실계좌 1차 익절 달성 (+6% 수익)]\n• 종목: " + symbol);
                }
            }
        }
    } catch (e) {
        console.error("⚠️ 포지션 관리 루프 에러:", e.message);
    }
}

async function checkAndExecute() {
    if (isExecutionLocked) return;
    isExecutionLocked = true;

    try {
        // ★ _MANAGE_SEPARATE: 익절/손절 관리는 앱 상태와 무관하게 항상 실행
        try {
            await _detectManualClose();
            await manageActivePositions();
        } catch (e) { console.error('[관리루프]', e.message); }

        // ★ 앱 제어 체크 (신규 진입만 차단)
        const enabled = await isAutomaticEnabled();
        if (!enabled) {
            console.log('⏸️ [LIVE] 앱 정지 (automaticEnabled=false) - 신규 진입만 대기');
            isExecutionLocked = false;
            return;
        }
        if (!fs.existsSync(CANDIDATE_PATH)) {
            isExecutionLocked = false;
            return;
        }

        let rawContent = "";
        try {
            rawContent = fs.readFileSync(CANDIDATE_PATH, 'utf8').trim();
        } catch (readErr) {
            isExecutionLocked = false;
            return;
        }

        if (!rawContent || rawContent.length < 5) {
            isExecutionLocked = false;
            return;
        }

        let data;
        try {
            data = JSON.parse(rawContent);
        
        // [수술] 재진입 방지 - data.signals 순회 정확히 처리
        if (data && Array.isArray(data.signals)) {
            const fileTs = data.timestamp || "";
            data.signals = data.signals.filter(item => {
                const symbol = item.symbol;
                const sigKey = symbol + "::" + fileTs;  // 파일 타임스탬프 기반 유니크 키
                const lastProcessed = processedSignals.get(symbol);
                if (lastProcessed === sigKey) {
                    console.log("[중복 진입 차단] " + symbol + " 이미 처리된 시그널. 스캐너 갱신 대기.");
                    return false;
                }
                return true;
            });
            // 처리된 시그널 기록 (진입 성공 시점에 하도록 별도로)
        }
        } catch (parseErr) {
            isExecutionLocked = false;
            return;
        }

        const signals = data.signals || [];
        const openPositions = await getOpenPositions();
        const activeSymbols = openPositions.map(p => p.symbol);

        const newSignals = signals.filter(sig => !activeSymbols.includes(sig.symbol));

        if (newSignals.length > 0 && activeSymbols.length < 3) {
            const totalBalance = await getUsdtBalance();
            const marginPerCoin = totalBalance * 0.33;

            console.log("🔥 [실계좌 New Execute] 총 잔고: $" + totalBalance.toFixed(2) + " | 신규 진입 대상: " + newSignals.map(s => s.symbol).join(', ') + " | 종목당 투입: $" + marginPerCoin.toFixed(2));

            for (const sig of newSignals) {
                // ★ 쿨다운 체크
                if (_isInCooldown(sig.symbol)) {
                    console.log("⏸️ [쿨다운] " + sig.symbol + " - 수동청산 후 재진입 대기 중");
                    continue;
                }
                const currentPositions = await getOpenPositions();
                if (currentPositions.some(p => p.symbol === sig.symbol)) {
                    console.log("🛡️ [중복 방지 차단] " + sig.symbol + "은 이미 포지션이 존재하여 진입을 취소합니다.");
                    continue;
                }

                await sendOrderWithRiskControl(sig.symbol || 'BTCUSDT', sig.side || 'SHORT', marginPerCoin);
            }
        } else {
            console.log("🛡️ [방어 작동] 현재 보유 종목 수: " + activeSymbols.length + "개. 추가 진입을 대기합니다.");
        }

        // manageActivePositions는 위에서 이미 호출됨

    } catch (err) {
        console.error("❌ 브리지 루프 에러:", err.message);
    } finally {
        isExecutionLocked = false;
    }
}

console.log("🚀 [ws-bitget] 3배 레버리지 + 수동청산 쿨다운 버전 가동 (Key Loaded: " + (API_KEY ? "YES" : "NO") + ")");
_initSnapshot().then(() => {
    checkAndExecute();
    setInterval(checkAndExecute, 30000);
});
