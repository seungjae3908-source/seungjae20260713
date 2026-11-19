import fs from 'fs';

const CANDIDATE_PATH = './candidates.json';

function checkAndSync() {
    try {
        // 만약 기존 스캐너 결과나 임시 데이터가 있다면 브리지 규격으로 변환 정렬
        const mockSignal = {
            timestamp: new Date().toISOString(),
            regime: "DOWN",
            leverage: 3,
            signals: [
                { symbol: "BTCUSDT", side: "SHORT", entry: 91500, score: 88, reason: "Downside momentum surge" },
                { symbol: "ETHUSDT", side: "SHORT", entry: 3120, score: 82, reason: "Volume breakout rejection" }
            ]
        };

        fs.writeFileSync(CANDIDATE_PATH, JSON.stringify(mockSignal, null, 2));
        console.log(`✅ [Sync] candidates.json 갱신 완료 (3배 레버리지 숏 2종목 대기 중)`);
    } catch (err) {
        console.error(`❌ Sync error:`, err.message);
    }
}

// 즉시 실행 및 30초 주기 갱신
checkAndSync();
setInterval(checkAndSync, 30000);
